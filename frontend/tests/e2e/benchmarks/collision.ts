import { chromium, type Page, type Browser } from 'playwright';
import { CONFIG, createRoom, joinRoom } from './utils';

export interface CollisionReport {
    success: boolean;
    collisionDetected: boolean;
    durationMs: number;
}

export const runCollisionSuite = async (
    browser: Browser,
    throttleCpu: boolean = false
): Promise<CollisionReport> => {

    const roomId = String(Math.floor(100000 + Math.random() * 900000));
    await createRoom(roomId, `CollisionAuto`);

    const tokenA = await joinRoom(roomId, 'UserA');
    const tokenB = await joinRoom(roomId, 'UserB');
    if (!tokenA || !tokenB) throw new Error("Join room failed");

    const context1 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const context2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageA = await context1.newPage();
    const pageB = await context2.newPage();

    if (throttleCpu) {
        const clientA = await context1.newCDPSession(pageA);
        await clientA.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        const clientB = await context2.newCDPSession(pageB);
        await clientB.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }

    let collisionDetected = false;
    const watchConsole = (msg: any) => {
        const text = msg.text();
        if (text.includes('需要重绘') || text.includes('接收到重绘事件')) {
            collisionDetected = true;
        }
    };
    pageA.on('console', watchConsole);
    pageB.on('console', watchConsole);

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
        setupPage(pageA, { token: tokenA.token, userName: 'UserA' }),
        setupPage(pageB, { token: tokenB.token, userName: 'UserB' })
    ]);

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

    // 刻意制造短兵相接的“交叉对角线”
    const start = performance.now();
    await Promise.all([
        drawLine(pageA, 500, 300, 700, 400),
        drawLine(pageB, 700, 300, 500, 400),
    ]);

    await new Promise(r => setTimeout(r, 4000)); // 给脏矩阵充足的判定消解时间
    const end = performance.now();

    await context1.close();
    await context2.close();

    return {
        success: collisionDetected,
        collisionDetected: collisionDetected,
        durationMs: end - start
    };
};
