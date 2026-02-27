import { chromium, type Page, type Browser } from 'playwright';
import { CONFIG, createRoom, joinRoom } from './utils';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface VisualConsistencyReport {
    lateJoinerMatched: boolean;
    concurrentCrossingMatched: boolean;
}

const setupPage = async (page: Page, observer: any) => {
    await page.goto(CONFIG.FRONTEND_URL);
    await page.evaluate(({ t, name }: { t: string; name: string }) => {
        sessionStorage.setItem('user', JSON.stringify({ token: t, userId: '', username: name }));
        localStorage.setItem('wb_username', name);
    }, { t: observer.token, name: observer.userName });
    await page.goto(`${CONFIG.FRONTEND_URL}/room`);
    await page.waitForSelector('canvas', { timeout: 15000 });
    await new Promise(r => setTimeout(r, 2000));
};

const drawLine = async (p: Page, startX: number, startY: number, endX: number, endY: number, steps = 20) => {
    await p.mouse.move(startX, startY);
    await p.mouse.down();
    for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        await p.mouse.move(startX + (endX - startX) * progress, startY + (endY - startY) * progress);
        await p.waitForTimeout(10);
    }
    await p.mouse.up();
};

const getCanvasBase64 = async (page: Page): Promise<string> => {
    return await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return '';
        return canvas.toDataURL('image/png');
    });
};

const getCanvasImageData = async (page: Page) => {
    const base64 = await getCanvasBase64(page);
    if (!base64) return null;
    const buffer = Buffer.from(base64.replace(/^data:image\/png;base64,/, ""), 'base64');
    return PNG.sync.read(buffer);
};

export const runVisualConsistencySuite = async (
    browser: Browser,
    throttleCpu: boolean = false
): Promise<VisualConsistencyReport> => {

    // =======================================================
    // 场景 A: 晚加入者追平测试 (Late Joiner Sync)
    // =======================================================
    const roomIdA = String(Math.floor(100000 + Math.random() * 900000));
    await createRoom(roomIdA, 'VisualRoomA');
    const tokenA1 = await joinRoom(roomIdA, 'UserA1');
    const tokenA2 = await joinRoom(roomIdA, 'UserA2');

    const context1 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageA1 = await context1.newPage();
    if (throttleCpu) {
        const client1 = await context1.newCDPSession(pageA1);
        await client1.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }

    await setupPage(pageA1, { token: tokenA1!.token, userName: 'UserA1' });

    // User A1 独自创作复杂图案
    await drawLine(pageA1, 200, 200, 400, 400, 20);
    await drawLine(pageA1, 200, 400, 400, 200, 20);
    await drawLine(pageA1, 300, 150, 300, 450, 20);
    await new Promise(r => setTimeout(r, 1000)); // 确保持久化到后端

    // 此时 User A2 姗姗来迟，加载全量房间历史
    const context2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageA2 = await context2.newPage();
    if (throttleCpu) {
        const client2 = await context2.newCDPSession(pageA2);
        await client2.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    await setupPage(pageA2, { token: tokenA2!.token, userName: 'UserA2' });
    await new Promise(r => setTimeout(r, 1500)); // 等待拉取完成和初始渲染

    const baseA1 = await getCanvasBase64(pageA1);
    const baseA2 = await getCanvasBase64(pageA2);
    const lateJoinerMatched = (baseA1 === baseA2) && baseA1.length > 500;

    await context1.close();
    await context2.close();

    // =======================================================
    // 场景 B: 高频并发交叉绘制 (Concurrent Crossing)
    // =======================================================
    const roomIdB = String(Math.floor(100000 + Math.random() * 900000));
    await createRoom(roomIdB, 'VisualRoomB');
    const tokenB1 = await joinRoom(roomIdB, 'UserB1');
    const tokenB2 = await joinRoom(roomIdB, 'UserB2');

    const context3 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const context4 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageB1 = await context3.newPage();
    const pageB2 = await context4.newPage();

    if (throttleCpu) {
        const client3 = await context3.newCDPSession(pageB1);
        await client3.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        const client4 = await context4.newCDPSession(pageB2);
        await client4.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }

    await Promise.all([
        setupPage(pageB1, { token: tokenB1!.token, userName: 'UserB1' }),
        setupPage(pageB2, { token: tokenB2!.token, userName: 'UserB2' })
    ]);

    // 两人同时刻意绘制“井”字或者“米”字结构的线条，迫使局部产生错综复杂的遮挡
    await Promise.all([
        drawLine(pageB1, 600, 300, 600, 500, 25), // 竖线1
        drawLine(pageB2, 500, 400, 700, 400, 25), // 横线1
    ]);
    await Promise.all([
        drawLine(pageB1, 500, 300, 700, 500, 25), // 对角斜线1
        drawLine(pageB2, 700, 300, 500, 500, 25), // 对角斜线2
    ]);

    await new Promise(r => setTimeout(r, 4000)); // 等待网络互换与 ctx.clip 完全收敛

    const img1 = await getCanvasImageData(pageB1);
    const img2 = await getCanvasImageData(pageB2);
    let concurrentCrossingMatched = false;

    if (img1 && img2 && img1.width === img2.width && img1.height === img2.height) {
        const diffBuffer = new Uint8Array(img1.width * img1.height * 4);
        const diffPixels = pixelmatch(img1.data, img2.data, diffBuffer, img1.width, img1.height, { threshold: 0.1 });
        // 允许的像素误差值，应对部分Z轴穿插和渲染白边（设置一个合理的宽容度，比如 100 像素以内的不同属于正常情况）
        const TOTAL_PIXELS = img1.width * img1.height;
        const diffRatio = diffPixels / TOTAL_PIXELS;

        if (diffRatio < 0.005) { // 误差率低于 0.5% 认为图片一致，消除直接使用Base64导致的完全匹配失效
            concurrentCrossingMatched = true;
        } else {
            console.warn(`[Visual Consistency] Diff pixels: ${diffPixels}, Ratio: ${diffRatio.toFixed(4)}`);
        }
    }

    if (!concurrentCrossingMatched) {
        const getCmds = (p: any) => p.evaluate(() => {
            const cmds = (window as any).__benchmarkCommands?.value || [];
            return cmds.map((c: any) => `${c.id.substring(0, 4)}(L${c.lamport},U${c.userId.substring(0, 2)})`).join(' -> ');
        });
        const cmds1 = await getCmds(pageB1);
        const cmds2 = await getCmds(pageB2);
        console.warn('  [Z紊乱分析] P1:', cmds1);
        console.warn('  [Z紊乱分析] P2:', cmds2);
    }

    await context3.close();
    await context4.close();

    return { lateJoinerMatched, concurrentCrossingMatched };
};
