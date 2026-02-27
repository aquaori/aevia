import { chromium, type Page, type Browser } from 'playwright';
import { CONFIG, createRoom, joinRoom, WebSocketInjector } from './utils';

export interface ChaosReport {
    targetNetworkMs: number;
    actualReconnectionTimeMs: number;
    droppedStateRecovered: boolean;
}

export const runChaosSuite = async (
    browser: Browser,
    throttleCpu: boolean = false
): Promise<ChaosReport> => {

    const roomId = String(Math.floor(100000 + Math.random() * 900000));
    await createRoom(roomId, `ChaosRoom`);

    const tokenA = await joinRoom(roomId, 'StableA');
    const tokenB = await joinRoom(roomId, 'PoorB');
    if (!tokenA || !tokenB) throw new Error("Join room failed");

    const context1 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const context2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageA = await context1.newPage();
    const pageB = await context2.newPage();

    let clientB: any;

    if (throttleCpu) {
        const clientA = await context1.newCDPSession(pageA);
        await clientA.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        clientB = await context2.newCDPSession(pageB);
        await clientB.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    } else {
        clientB = await context2.newCDPSession(pageB);
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

    await Promise.all([
        setupPage(pageA, { token: tokenA.token, userName: 'StableA' }),
        setupPage(pageB, { token: tokenB.token, userName: 'PoorB' })
    ]);

    // 1. 设置 B 的网络为极恶劣状态 (500ms 延迟，低带宽)
    await clientB.send('Network.enable');
    await clientB.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 500, // 500ms 延迟
        downloadThroughput: 50 * 1024 / 8, // 50kbps
        uploadThroughput: 50 * 1024 / 8
    });

    const drawLine = async (p: Page, startX: number, startY: number, endX: number, endY: number, steps = 15) => {
        await p.mouse.move(startX, startY);
        await p.mouse.down();
        for (let i = 1; i <= steps; i++) {
            const progress = i / steps;
            await p.mouse.move(startX + (endX - startX) * progress, startY + (endY - startY) * progress);
            await p.waitForTimeout(20);
        }
        await p.mouse.up();
    };

    const getCommandsDigest = async (p: Page) => {
        return await p.evaluate(() => {
            const cmds = (window as any).__benchmarkCommands?.value || [];
            return {
                len: cmds.length,
                hash: cmds.map((c: any) => c.id).join(',').substring(0, 100)
            }
        });
    };

    // 2. 在 B 脱胶或极度延迟时，A 强势操作 (制造未知的增量突变)
    const actionStart = performance.now();
    await drawLine(pageA, 100, 100, 300, 300);

    // 等 A 自己稳定下来，获取 A 的命令摘要作为基准
    await new Promise(r => setTimeout(r, 500));
    const digestABaseline = await getCommandsDigest(pageA);

    // 轮询等待 B 的命令数组追上 A（最长 10 秒）
    let bGotSync = false;
    let bSyncTime = 0;
    let waitLoops = 0;

    while (!bGotSync && waitLoops < 50) {
        await new Promise(r => setTimeout(r, 200));
        waitLoops++;
        const digestBNow = await getCommandsDigest(pageB);
        if (digestBNow.len === digestABaseline.len && digestBNow.len > 0 && digestBNow.hash === digestABaseline.hash) {
            bGotSync = true;
            bSyncTime = performance.now();
        }
    }

    // 恢复正常网络
    await clientB.send('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
    });

    const digestA = await getCommandsDigest(pageA);
    const digestB = await getCommandsDigest(pageB);
    const droppedStateRecovered = (digestA.len === digestB.len && digestA.len > 0 && digestA.hash === digestB.hash);

    await context1.close();
    await context2.close();

    return {
        targetNetworkMs: 500,
        actualReconnectionTimeMs: bSyncTime > 0 ? bSyncTime - actionStart : 0,
        droppedStateRecovered
    };
};
