import { chromium, type Page, type Browser } from 'playwright';
import { CONFIG, createRoom, joinRoom, WebSocketInjector } from './utils';
import { v4 as uuidv4 } from 'uuid';

export interface LatencyReport {
    firstDrawMs: number;
    e2eSyncMs: number;
}

export const runLatencySuite = async (
    browser: Browser,
    throttleCpu: boolean = false
): Promise<LatencyReport> => {
    const roomId = String(Math.floor(100000 + Math.random() * 900000));
    await createRoom(roomId, `LatencyRoom`);

    const observer = await joinRoom(roomId, 'Observer');
    if (!observer) throw new Error("Observer joining failed");

    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page: Page = await context.newPage();

    if (throttleCpu) {
        const client = await context.newCDPSession(page);
        await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }

    // 设置用于掐表的全局 Hook
    let firstDrawResolve: (ms: number) => void;
    let e2eDrawResolve: (ms: number) => void;

    let firstDrawStart = 0;
    let expectedE2EId = '';
    let e2eSendTime = 0;

    await page.exposeBinding('__benchmarkHook', (source, cmdId: string) => {
        const now = Date.now();
        // 测算起笔延迟
        if (firstDrawStart > 0 && Math.abs(now - firstDrawStart) < 5000) { // 简单过滤只在测试窗口期有效
            firstDrawResolve(now - firstDrawStart);
            firstDrawStart = 0; // 消费掉
        }
        // 测算 E2E 延迟
        if (cmdId === expectedE2EId) {
            e2eDrawResolve(now - e2eSendTime);
        }
    });

    await page.goto(CONFIG.FRONTEND_URL);
    await page.evaluate(({ t, name }: { t: string; name: string }) => {
        sessionStorage.setItem('user', JSON.stringify({ token: t, userId: '', username: name }));
        localStorage.setItem('wb_username', name);
    }, { t: observer.token, name: `Observer` });

    await page.goto(`${CONFIG.FRONTEND_URL}/room`);
    await page.waitForSelector('canvas', { timeout: 15000 });
    // 让其初次就绪
    await new Promise(r => setTimeout(r, 1000));

    // ============================================
    // 测试点 1：起笔跟随延迟 (First Draw Latency)
    // 模拟本地用户用鼠标开始画第一根线，计算从 Input 到 Render 的回路时长
    // ============================================
    const firstDrawPromise = new Promise<number>((r) => firstDrawResolve = r);

    // 获取画布包围盒以准备真实点击
    const canvasBox = await page.locator('canvas').first().boundingBox();
    if (!canvasBox) throw new Error("找不到画布");

    firstDrawStart = Date.now();
    await page.mouse.move(canvasBox.x + 200, canvasBox.y + 200);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 210, canvasBox.y + 210, { steps: 2 });
    await page.mouse.up();

    // 容错处理：若 3 秒未上屏或没走到 hook
    const firstDrawMs = await Promise.race([
        firstDrawPromise,
        new Promise<number>(r => setTimeout(() => r(-1), 3000))
    ]);


    // ============================================
    // 测试点 2：跨端协同 E2E 同步延迟
    // 启动一个极客机器人通过原生 WS 后门直接打出 cmd-start 封包，浏览器接收并上屏的时间差
    // ============================================
    const e2ePromise = new Promise<number>((r) => e2eDrawResolve = r);

    const u = await joinRoom(roomId, `RemoteHacker`);
    if (!u) throw new Error("Bot 建号失败");
    const inj = new WebSocketInjector(roomId, `RemoteHacker`, u.token, u.userId);
    await inj.connect();

    expectedE2EId = uuidv4();
    e2eSendTime = Date.now();

    // 直接由 Injector 后门发包
    // @ts-ignore - 访问私有的 websocket 以强发消息
    inj.ws?.send(JSON.stringify({
        type: 'cmd-start',
        data: {
            id: expectedE2EId,
            lamport: 999,
            cmd: {
                id: expectedE2EId,
                type: 'path',
                points: [{ x: 0.5, y: 0.5, p: 0.5 }],
                tool: 'pen',
                color: '#ff0000',
                size: 5,
                timestamp: e2eSendTime,
                userId: u.userId,
                roomId: roomId,
                pageId: 0,
                isDeleted: false,
                lamport: 999,
            }
        }
    }));

    const e2eSyncMs = await Promise.race([
        e2ePromise,
        new Promise<number>(r => setTimeout(() => r(-1), 5000))
    ]);

    inj.close();
    await context.close();

    return {
        firstDrawMs,
        e2eSyncMs
    };
};


