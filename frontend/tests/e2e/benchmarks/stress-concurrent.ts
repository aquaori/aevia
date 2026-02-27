import { chromium, type Page, type Browser } from 'playwright';
import { CONFIG, createRoom, joinRoom, WebSocketInjector } from './utils';

export interface StressReport {
    averageFps: number;
    maxMainThreadBlockMs: number;
    totalPointsInjected: number;
    isConsistent: boolean;
}

export const runStressSuite = async (
    browser: Browser,
    throttleCpu: boolean = false
): Promise<StressReport> => {

    const roomId = String(Math.floor(100000 + Math.random() * 900000));
    await createRoom(roomId, `StressRoom`);

    const observer1 = await joinRoom(roomId, 'Observer1');
    const observer2 = await joinRoom(roomId, 'Observer2');
    if (!observer1 || !observer2) throw new Error("Observer joining failed");

    const context1 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const context2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page1: Page = await context1.newPage();
    const page2: Page = await context2.newPage();

    if (throttleCpu) {
        const client = await context1.newCDPSession(page1);
        await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        const client2 = await context2.newCDPSession(page2);
        await client2.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }

    // 在页面中注入帧监控 (rAF 循环) 以测量主线程卡死情况和平均 FPS
    await page1.addInitScript(() => {
        (window as any).__stressStats = {
            maxBlockTime: 0,
            frameCount: 0,
            startTime: 0,
            totalRunningMs: 0
        };
        let lastTime = performance.now();
        (window as any).__stressStats.startTime = lastTime;

        const loop = (now: number) => {
            const delta = now - lastTime;
            if (delta > (window as any).__stressStats.maxBlockTime) {
                (window as any).__stressStats.maxBlockTime = delta;
            }
            (window as any).__stressStats.frameCount++;
            (window as any).__stressStats.totalRunningMs = now - (window as any).__stressStats.startTime;
            lastTime = now;
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    });

    const setupPage = async (page: Page, observer: any) => {
        await page.goto(CONFIG.FRONTEND_URL);
        await page.evaluate(({ t, name }: { t: string; name: string }) => {
            sessionStorage.setItem('user', JSON.stringify({ token: t, userId: '', username: name }));
            localStorage.setItem('wb_username', name);
        }, { t: observer.token, name: observer.userName });
        await page.goto(`${CONFIG.FRONTEND_URL}/room`);
        await page.waitForSelector('canvas', { timeout: 15000 });
    };

    await Promise.all([
        setupPage(page1, { token: observer1.token, userName: 'Observer1' }),
        setupPage(page2, { token: observer2.token, userName: 'Observer2' })
    ]);

    // 等待稳定，重置数据准备开始测试
    await new Promise(r => setTimeout(r, 2000));
    await page1.evaluate(() => {
        (window as any).__stressStats.maxBlockTime = 0;
        (window as any).__stressStats.frameCount = 0;
        (window as any).__stressStats.startTime = performance.now();
    });

    // 制造高并发压力：20 个活跃用户同时以 60Hz 手速狂画 10 秒钟
    const injectors = [];
    const VIRTUAL_USERS = 20;

    for (let i = 0; i < VIRTUAL_USERS; i++) {
        const cred = await joinRoom(roomId, `StressBot_${i}`);
        if (!cred) throw new Error("Auth failed");
        const inj = new WebSocketInjector(roomId, `StressBot_${i}`, cred.token, cred.userId);
        await inj.connect();
        injectors.push(inj);
    }

    // 同时开火：10秒钟 60FPS 的连续坐标投递，每次落笔不得超过500个点
    const DURATION = 10000;
    const injectionPromises = injectors.map(inj => inj.injectRealtimeStrokes(60, DURATION, 500));
    const pointsInjectedArray = await Promise.all(injectionPromises);
    const totalPointsInjected = pointsInjectedArray.reduce((sum, curr) => sum + curr, 0);

    // 留出最后3秒的渲染消化期
    await new Promise(r => setTimeout(r, 3000));

    const stats = await page1.evaluate(() => (window as any).__stressStats);
    // 计算真实渲染 FPS (按实际运行时间)
    const averageFps = (stats.frameCount / (stats.totalRunningMs / 1000));

    // [CRDT 指标验证] State Equivalence Check - 终态一致性对账
    const getCommandsDigest = async (p: Page) => {
        return await p.evaluate(() => {
            const cmds = (window as any).__benchmarkCommands?.value || [];
            return {
                len: cmds.length,
                hash: cmds.map((c: any) => c.id).join(',').substring(0, 100) // 简单取百位长特征码
            }
        });
    };

    const digest1 = await getCommandsDigest(page1);
    const digest2 = await getCommandsDigest(page2);

    // 断言数组长度大于0，且两端数组长度与内容完全同构
    const isConsistent = (digest1.len === digest2.len && digest1.len > 0 && digest1.hash === digest2.hash);

    if (!isConsistent) {
        console.warn(`[状态破损警告] Obs1(len=${digest1.len}) VS Obs2(len=${digest2.len})`);
    }

    injectors.forEach(inj => inj.close());
    await context1.close();
    await context2.close();

    return {
        averageFps,
        maxMainThreadBlockMs: stats.maxBlockTime,
        totalPointsInjected,
        isConsistent
    };
};
