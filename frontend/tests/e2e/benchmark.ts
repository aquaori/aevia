/**
 * 协同画板全量渲染 Benchmark
 * 
 * 核心实现：脱离 Playwright 的 UI 模拟，直接使用 Node.js 的 原生 WebSocket 框架
 * 建立多个并发客户端，光速向后端服务器注入十万至百万级带不同颜色和粗细的压力测试点，
 * 然后控制观测者浏览器进场，对网络耗时、总感知时间、渲染纯时间进精细化度量。
 *
 * 运行：npx tsx tests/e2e/benchmark.ts
 */

import { chromium, type Page } from 'playwright';
import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';

// ========== 配置区 ==========
const CONFIG = {
    API_URL: 'http://192.168.10.102:4646',
    WS_URL: 'ws://192.168.10.102:4646',
    FRONTEND_URL: 'http://localhost:5173',
    ROOM_PASSWORD: '',

    // 默认执行测试的多个量级 (可执行单个或多个)
    // 分档: 1万, 5万, 10万, 30万
    SCALES_TO_RUN: [10000, 50000, 100000, 300000],

    // 多少个并发 WebSocket 机器人共同灌数据
    WS_CLIENT_COUNT: 5,

    // 一个笔画/线条里的点数 (影响绘制多少个分段)
    POINTS_PER_STROKE: 300,

    COLORS: [
        "#000000", "#ef4444", "#f97316", "#fbbf24",
        "#84cc16", "#22c55e", "#06b6d4", "#3b82f6",
        "#6366f1", "#a855f7", "#ec4899", "#ffffff",
    ],
};

// 工具方法：发送 HTTP 请求
const request = async (url: string, body: any) => {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return res.json();
};

const joinRoom = async (roomId: string, userName: string) => {
    const data = await request(`${CONFIG.API_URL}/join-room`, { roomId, userName, password: CONFIG.ROOM_PASSWORD });
    return data.code === 200 ? { token: data.data.token, userId: data.data.userId } : null;
};

// ========== 极速数据灌入层 (Node.js WebSocket) ==========

class WebSocketInjector {
    private ws: WebSocket | null = null;
    private resolveInit: Function | null = null;
    public isReady = false;
    private lamport = 0;

    constructor(
        public roomId: string,
        public userName: string,
        public token: string,
        public userId: string
    ) { }

    async connect() {
        return new Promise<void>((resolve, reject) => {
            this.ws = new WebSocket(CONFIG.WS_URL, [this.token]);

            this.ws.on('open', () => {
                // 等待认证或 init 消息，大部分是在 onmessage 触发
            });

            this.ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type === 'init') {
                        this.isReady = true;
                        if (this.resolveInit) {
                            this.resolveInit();
                            this.resolveInit = null;
                        } else {
                            resolve();
                        }
                    }
                } catch (e) { }
            });

            this.ws.on('error', reject);

            setTimeout(() => {
                if (!this.isReady) reject(new Error('WS 认证超时'));
            }, 5000);
        });
    }

    // 执行灌水，目标要求这个机器人画 targetPoints 个点
    async injectPoints(targetPoints: number) {
        if (!this.ws || !this.isReady) throw new Error('Injector 未就绪');

        let sentPoints = 0;
        let strokes = Math.ceil(targetPoints / CONFIG.POINTS_PER_STROKE);

        // 我们不等待服务端的 ACK，直接向套接字疯狂写入，这能最大化并发吞吐量
        for (let s = 0; s < strokes; s++) {
            const cmdId = uuidv4();
            const color = CONFIG.COLORS[Math.floor(Math.random() * CONFIG.COLORS.length)];
            const size = Math.floor(Math.random() * 8) + 2; // 2 ~ 9 px

            let x = 100 + Math.random() * 1000;
            let y = 100 + Math.random() * 600;

            const currentPoints: any[] = [];
            let steps = Math.min(CONFIG.POINTS_PER_STROKE, targetPoints - sentPoints);

            for (let i = 0; i < steps; i++) {
                // 游走
                x += (Math.random() - 0.5) * 15;
                y += (Math.random() - 0.5) * 15;
                const p = 0.2 + Math.random() * 0.8; // pressure

                // 为了兼容精度规约
                const p0 = {
                    x: Math.round((x / 1280) * 100000) / 100000,
                    y: Math.round((y / 720) * 100000) / 100000,
                    p: Math.round(p * 100000) / 100000
                };

                currentPoints.push(p0);
                this.lamport++;
                sentPoints++;

                if (i === 0) {
                    // Start 包
                    const cmdObj = {
                        id: cmdId,
                        type: 'path',
                        points: [...currentPoints],
                        tool: 'pen',
                        color: color,
                        size: size,
                        timestamp: Date.now(),
                        userId: this.userId,
                        roomId: this.roomId,
                        pageId: 0,
                        isDeleted: false,
                        lamport: this.lamport,
                        box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }
                    };
                    const payload = { type: 'cmd-start', data: { id: cmdId, cmd: cmdObj, lamport: this.lamport } };
                    this.ws.send(JSON.stringify(payload));
                }

                if (i === steps - 1) {
                    // Stop 包（携带完整的所有 points）
                    const cmdObj = {
                        id: cmdId,
                        type: 'path',
                        points: [...currentPoints],
                        tool: 'pen',
                        color: color,
                        size: size,
                        timestamp: Date.now(),
                        userId: this.userId,
                        roomId: this.roomId,
                        pageId: 0,
                        isDeleted: false,
                        lamport: this.lamport,
                        box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }
                    };
                    const payload = { type: 'cmd-stop', data: { cmdId: cmdId, cmd: cmdObj, lamport: this.lamport, points: [...currentPoints], box: cmdObj.box } };
                    this.ws.send(JSON.stringify(payload));
                }

                // 稍微休息一下，防止发送缓冲区爆掉引起 EPIPE 或后端的 WebSocket 拥塞控制
                if (i % 50 === 0) {
                    await new Promise(r => setTimeout(r, 1));
                }
            }

            // 每笔画完稍微停顿，给后端事件循环一点喘息的窗口，否则由于 Node.js 的高吞吐很容易直接把服务端内存打爆
            await new Promise(r => setTimeout(r, 5));
        }

        return sentPoints;
    }

    close() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}


// ========== 测试主框架 ==========

interface BenchmarkReport {
    scale: number;
    injectTimeMs: number;
    payloadSizeKb: number;
    networkSyncMs: number;
    domReadyMs: number;
    pureRenderMs: number;
    totalPerceivedMs: number;
    throughputTps: number;
}

const runBenchmarkForScale = async (scale: number, browser: any): Promise<BenchmarkReport> => {
    console.log(`\n\n=============================================================`);
    console.log(`🚀 [Benchmark] 开始评测级别: ${scale.toLocaleString()} 点`);
    console.log(`=============================================================`);

    const roomId = String(Math.floor(100000 + Math.random() * 900000));
    await request(`${CONFIG.API_URL}/create-room`, { roomId, roomName: `Bench_${scale}`, password: '' });

    // --- 阶段一：极速灌水 ---
    console.log(`\n  📝 [阶段一] 开始实例化并发 Injector 机器人...`);
    const injectors: WebSocketInjector[] = [];
    const pointsPerClient = Math.ceil(scale / CONFIG.WS_CLIENT_COUNT);

    for (let i = 0; i < CONFIG.WS_CLIENT_COUNT; i++) {
        const u = await joinRoom(roomId, `Bot_${i}`);
        if (!u) throw new Error("建 Bot 失败");
        const inj = new WebSocketInjector(roomId, `Bot_${i}`, u.token, u.userId);
        await inj.connect();
        injectors.push(inj);
    }

    console.log(`  🔌 ${CONFIG.WS_CLIENT_COUNT} 个机器人已连接，开始以机器光速注入数据...`);
    const injStart = performance.now();

    // 并发打数据
    await Promise.all(injectors.map(inj => inj.injectPoints(pointsPerClient)));

    const injEnd = performance.now();
    const injectTimeMs = injEnd - injStart;
    console.log(`  ✅ 灌水完成！真实耗时 ${injectTimeMs.toFixed(0)}ms (TPS: ${(scale / (injectTimeMs / 1000)).toFixed(0)})`);

    // 等待服务端将数据刷入存储 / 消化完
    console.log(`  ⏳ 留给服务端 3 秒缓冲时间消化消息积压...`);
    await new Promise(r => setTimeout(r, 3000));

    // 清理连接
    injectors.forEach(j => j.close());


    // --- 阶段二：观测者进场提取指标 ---
    console.log(`\n  ⏱️ [阶段二] 观测者浏览器进场，全量捕获指标`);

    const observer = await joinRoom(roomId, 'Observer');
    if (!observer) throw new Error("Observer joining failed");

    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page: Page = await context.newPage();

    let initPayloadBytes = 0;

    // 1. 监听 WebSocket Payload 体积
    page.on('websocket', ws => {
        ws.on('framereceived', frame => {
            const data = frame.payload;
            const str = typeof data === 'string' ? data : data.toString('utf-8');
            if (str.includes('"type":"init"')) {
                // 简单估算字节数
                initPayloadBytes = Buffer.byteLength(str, 'utf8');
            }
        });
    });

    let renderTimeMs = 0;
    let actualPointsRendered = 0;
    let isRenderFired = false;

    // 2. 监听渲染完成锚点
    const renderCompletePromise = new Promise<void>((resolve, reject) => {
        page.on('console', msg => {
            const text = msg.text();
            if (text.includes('[全量渲染完成]') && !text.includes('点数=0') && !isRenderFired) {
                isRenderFired = true;
                const match1 = text.match(/耗时=([\d\.]+)ms/);
                const match2 = text.match(/点数=(\d+)/);
                if (match1) renderTimeMs = parseFloat(match1[1]);
                if (match2) actualPointsRendered = parseInt(match2[1], 10);
                resolve();
            }
        });

        // 超时保底处理（有些极大量级可能需要数十秒）
        setTimeout(() => { if (!isRenderFired) reject(new Error('首次渲染等待超时')) }, 60000);
    });

    console.log(`  🚦 Observer 跳转`);
    await page.goto(CONFIG.FRONTEND_URL);
    await page.evaluate(({ t, name }: { t: string; name: string }) => {
        sessionStorage.setItem('user', JSON.stringify({ token: t, userId: '', username: name }));
        localStorage.setItem('wb_username', name);
    }, { t: observer.token, name: `Observer` });

    const navStart = performance.now();
    await page.goto(`${CONFIG.FRONTEND_URL}/room`);

    // 等待 DOM （即画布标签呈现）
    await page.waitForSelector('canvas', { timeout: 15000 });
    const domReadyTime = performance.now();
    const domReadyMs = domReadyTime - navStart;

    // 等待渲染真正触发、结束
    await renderCompletePromise;
    const renderCompleteTime = performance.now();

    const totalPerceivedMs = renderCompleteTime - navStart;
    const networkSyncMs = totalPerceivedMs - renderTimeMs - domReadyMs; // 粗略推算网络传输和反序列化的损耗

    const payloadKb = initPayloadBytes / 1024;
    console.log(`  📸 观测完成。实际呈现点数: ${actualPointsRendered} (要求=${scale})`);

    await context.close();

    return {
        scale: scale,
        injectTimeMs,
        payloadSizeKb: payloadKb,
        networkSyncMs: Math.max(0, networkSyncMs),
        domReadyMs,
        pureRenderMs: renderTimeMs,
        totalPerceivedMs,
        throughputTps: actualPointsRendered / (renderTimeMs / 1000)
    };
};

// ========== 执行报告生成 ==========

(async () => {
    console.log('✨ 初始化 Benchmark 测试框架...');
    const browser = await chromium.launch({ headless: true, channel: 'chrome' }); // 使用纯 Headless 降低桌面开销干扰

    const results: BenchmarkReport[] = [];

    for (const scale of CONFIG.SCALES_TO_RUN) {
        try {
            const report = await runBenchmarkForScale(scale, browser);
            results.push(report);
        } catch (e: any) {
            console.error(`\n❌ 量级 ${scale} 测试失败: ${e.message}`);
        }
        // 量级间休息 3 秒，避免服务端资源抢占
        await new Promise(r => setTimeout(r, 3000));
    }

    await browser.close();

    // 打印 Markdown 格式总结
    console.log(`\n\n`);
    console.log(`🚀 协同画板性能评测报告 (Benchmark Report) `);
    console.log(`===================================================================================================`);
    console.log(`| 测试量级 | Init包大小 | 纯渲染耗时 | 用户感知总用时 | 渲染引擎 TPS | 备注 |`);
    console.log(`|---------:|-----------:|-----------:|--------------:|-------------:|:-----|`);

    for (const r of results) {
        const scaleStr = r.scale >= 10000 ? `${r.scale / 10000}万` : `${r.scale}`;
        const sizeStr = r.payloadSizeKb > 1024 ? `${(r.payloadSizeKb / 1024).toFixed(2)} MB` : `${r.payloadSizeKb.toFixed(1)} KB`;
        const renderStr = `${r.pureRenderMs.toFixed(0)} ms`;
        const totalStr = `${r.totalPerceivedMs.toFixed(0)} ms`;
        const tpsStr = `${(r.throughputTps / 10000).toFixed(1)}万/秒`;

        let status = '流畅';
        if (r.pureRenderMs > 100) status = '轻微掉帧';
        if (r.pureRenderMs > 300) status = '卡顿';
        if (r.pureRenderMs > 800) status = '重度卡顿';

        console.log(`| ${scaleStr.padStart(8)} | ${sizeStr.padStart(10)} | ${renderStr.padStart(10)} | ${totalStr.padStart(13)} | ${tpsStr.padStart(12)} | ${status} |`);
    }
    console.log(`===================================================================================================`);
    console.log(`\n📝 指标定义说明:`);
    console.log(`- **Init包大小**: 真实首次 WebSocket 协商获得的初期增量总表 Json 大小。`);
    console.log(`- **纯渲染耗时**: renderPageContent() 内循环遍历与 Canvas 物理 GPU 绘制时间。`);
    console.log(`- **用户感知总用时**: 从点击加入房间起，经过网络请求、包结构解析、DOM渲染最终落点上屏的极限体感时长。`);
    console.log(`- **渲染引擎 TPS**: 渲染纯时长计算出的每秒极值输出能力(Throughput per second)。\n`);

    process.exit(0);

})();
