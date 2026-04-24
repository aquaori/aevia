/**
 * 协同画板 - 脏区域局部重绘 端到端自动化测试
 * 
 * 场景一：「同 Lamport 交叉碰撞」 ── 两用户同时画交叉线（A黑B红），触发碰撞重绘
 * 场景二：「迟到数据脏区域重绘」 ── Node.js WebSocket 直连后端，发送 lamport=1 的红色竖线
 * 场景三：「重绘后视觉一致性」 ── 两人交替画线，对比双端 commands 数据一致性
 * 
 * 运行：npx tsx tests/e2e/dirty-rerender-test.ts
 */

import { chromium, type Page } from 'playwright';
import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';

// ========== 配置区 ==========
const CONFIG = {
    API_URL: 'http://192.168.10.102:4646',
    WS_URL: 'ws://192.168.10.102:4646',
    FRONTEND_URL: 'http://localhost:5173',
    ROOM_PASSWORD: '',
    DRAW_STEPS: 25,
    STEP_DELAY_MS: 20,
    SCENARIO_TIMEOUT_MS: 60000,
    SCREENSHOT_DIR: 'tests/e2e/screenshots/dirty-rerender',
};

// ========== 工具函数 ==========

const generateRoomId = (): string => String(Math.floor(100000 + Math.random() * 900000));

const createRoom = async (roomId: string, roomName: string): Promise<boolean> => {
    try {
        const res = await fetch(`${CONFIG.API_URL}/create-room`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId, roomName, password: CONFIG.ROOM_PASSWORD }),
        });
        const data = await res.json();
        return data.code === 200;
    } catch (err) {
        console.error('❌ 创建房间失败:', err);
        return false;
    }
};

const joinRoom = async (roomId: string, userName: string): Promise<{ token: string; userId: string } | null> => {
    try {
        const res = await fetch(`${CONFIG.API_URL}/join-room`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId, userName, password: CONFIG.ROOM_PASSWORD }),
        });
        const data = await res.json();
        return data.code === 200 ? { token: data.data.token, userId: data.data.userId } : null;
    } catch (err) {
        console.error(`❌ ${userName} 加入房间失败:`, err);
        return null;
    }
};

const setupPage = async (page: Page, token: string, userName: string): Promise<void> => {
    await page.goto(CONFIG.FRONTEND_URL);
    await page.evaluate(({ t, name }: { t: string; name: string }) => {
        sessionStorage.setItem('user', JSON.stringify({ token: t, userId: '', username: name }));
        localStorage.setItem('wb_username', name);
    }, { t: token, name: userName });
    await page.goto(`${CONFIG.FRONTEND_URL}/room`);
    await page.waitForSelector('canvas', { timeout: 15000 });
    await new Promise(r => setTimeout(r, 2000));
};

const drawLine = async (
    page: Page,
    startX: number, startY: number,
    endX: number, endY: number,
    steps: number = CONFIG.DRAW_STEPS,
    label: string = ''
): Promise<void> => {
    try {
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        for (let i = 1; i <= steps; i++) {
            const progress = i / steps;
            await page.mouse.move(
                startX + (endX - startX) * progress,
                startY + (endY - startY) * progress
            );
            await page.waitForTimeout(CONFIG.STEP_DELAY_MS);
        }
        await page.mouse.up();
        console.log(`  ✅ ${label} 画线完成: (${startX},${startY}) → (${endX},${endY})`);
    } catch (err) {
        console.error(`  ❌ ${label} 画线异常:`, err);
        try { await page.mouse.up(); } catch (_) { }
    }
};

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`⏰ ${label} 超时 (${ms}ms)`)), ms))
    ]);
};

const getCommandsDigest = async (page: Page) => {
    return await page.evaluate(() => {
        const cmds = (window as any).__benchmarkCommands?.value || [];
        return {
            len: cmds.length,
            ids: cmds.map((c: any) => c.id).join(',').substring(0, 200),
        };
    });
};

// ========== WebSocket 迟到命令注入器 ==========

/**
 * 通过 Node.js WebSocket 直连后端，发送一个 lamport 极低的红色竖线命令。
 * 当前端浏览器收到这条命令时，其 Lamport 时间戳远低于哨兵队列水位，
 * 会命中 pushToQueue 的"过去"分支，触发脏区域重绘。
 */
const injectLateCommand = async (
    roomId: string,
    token: string,
    userId: string
): Promise<{ success: boolean; cmdId: string; lamport: number }> => {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(CONFIG.WS_URL, [token]);
        const cmdId = 'late-' + uuidv4().slice(0, 8);
        const fakeLamport = 1; // 极低的 Lamport 值

        // 生成归一化坐标的竖线点 (x=0.35, y从0.15到0.75)
        // 这条竖线会穿过三条黑色横线
        const points: any[] = [];
        const numPoints = 20;
        const xNorm = 0.35;
        for (let i = 0; i <= numPoints; i++) {
            points.push({
                x: Math.round(xNorm * 100000) / 100000,
                y: Math.round((0.15 + 0.60 * i / numPoints) * 100000) / 100000,
                p: 0.5,
                lamport: fakeLamport,
            });
        }

        const cmdObj = {
            id: cmdId,
            type: 'path',
            points: [...points],
            tool: 'pen',
            color: '#ef4444',  // 红色
            size: 5,
            timestamp: Date.now(),
            userId: userId,
            roomId: roomId,
            pageId: 0,
            isDeleted: false,
            lamport: fakeLamport,
            box: {
                minX: xNorm - 0.01,
                minY: 0.14,
                maxX: xNorm + 0.01,
                maxY: 0.76,
                width: 0.02,
                height: 0.62
            }
        };

        ws.on('open', () => {
            // 等 init 消息
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'init') {
                    console.log('  🔌 WebSocket 注入器已连接并认证');

                    // 发送 cmd-start
                    ws.send(JSON.stringify({
                        type: 'cmd-start',
                        data: {
                            id: cmdId,
                            cmd: { ...cmdObj, points: [points[0]] },
                            lamport: fakeLamport,
                        }
                    }));

                    // 发送 cmd-stop（携带完整点列表）
                    ws.send(JSON.stringify({
                        type: 'cmd-stop',
                        data: {
                            cmdId: cmdId,
                            cmd: cmdObj,
                            lamport: fakeLamport,
                            points: points,
                            box: cmdObj.box,
                        }
                    }));

                    console.log(`  📤 已发送红色竖线命令 (id=${cmdId}, lamport=${fakeLamport}, ${points.length}个点)`);

                    // 稍等后关闭
                    setTimeout(() => {
                        ws.close();
                        resolve({ success: true, cmdId, lamport: fakeLamport });
                    }, 1000);
                }
            } catch (e) { }
        });

        ws.on('error', (err) => {
            reject(err);
        });

        setTimeout(() => {
            ws.close();
            reject(new Error('WebSocket 注入超时'));
        }, 10000);
    });
};

// ========== 测试场景 ==========

interface TestResult {
    name: string;
    passed: boolean;
    details: string;
}

/**
 * 场景一：同 Lamport 交叉碰撞重绘
 * A(黑)↘ B(红)↙ 同时画交叉线
 */
const testCrossCollision = async (browser: any): Promise<TestResult> => {
    console.log('\n══════════════════════════════════════════');
    console.log('  🧪 场景一：同 Lamport 交叉碰撞重绘');
    console.log('══════════════════════════════════════════\n');

    const roomId = generateRoomId();
    await createRoom(roomId, '交叉碰撞测试');
    const userA = await joinRoom(roomId, 'CrossA');
    const userB = await joinRoom(roomId, 'CrossB');
    if (!userA || !userB) return { name: '交叉碰撞', passed: false, details: '无法获取 token' };

    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    let rerenderCountA = 0;
    let rerenderCountB = 0;

    pageA.on('console', (msg: any) => {
        if (msg.text().includes('接收到重绘事件')) rerenderCountA++;
    });
    pageB.on('console', (msg: any) => {
        if (msg.text().includes('接收到重绘事件')) rerenderCountB++;
    });

    await setupPage(pageA, userA.token, 'CrossA');
    await setupPage(pageB, userB.token, 'CrossB');
    await new Promise(r => setTimeout(r, 2000));

    // B 切换为红色画笔
    console.log('  🎨 设定颜色: A=黑色(默认), B=红色...');
    await pageB.evaluate(() => {
        const colorRef = (window as any).__benchmarkCurrentColor;
        if (colorRef) colorRef.value = '#ef4444';
    });
    await new Promise(r => setTimeout(r, 300));

    console.log('  🎯 开始同时画交叉线 (X 形): A=黑色↘, B=红色↙...');
    await Promise.all([
        drawLine(pageA, 400, 250, 800, 450, CONFIG.DRAW_STEPS, 'A(黑)'),
        drawLine(pageB, 800, 250, 400, 450, CONFIG.DRAW_STEPS, 'B(红)'),
    ]);

    console.log('  ⏳ 等待碰撞检测与重绘...');
    await new Promise(r => setTimeout(r, 5000));

    await pageA.screenshot({ path: `${CONFIG.SCREENSHOT_DIR}/cross_A.png` });
    await pageB.screenshot({ path: `${CONFIG.SCREENSHOT_DIR}/cross_B.png` });

    const passed = (rerenderCountA > 0 || rerenderCountB > 0);
    console.log(`  📊 结果: A 重绘=${rerenderCountA}次, B 重绘=${rerenderCountB}次`);

    await ctxA.close();
    await ctxB.close();

    return {
        name: '同 Lamport 交叉碰撞重绘',
        passed,
        details: `A: 重绘${rerenderCountA}次, B: 重绘${rerenderCountB}次`
    };
};

/**
 * 场景二：迟到数据（"过去"分支）脏区域重绘
 * 
 * 1. B 先画 3 条黑色横线，推高 Lamport 队列水位
 * 2. Node.js WebSocket 直连后端，发送 lamport=1 的红色竖线命令
 * 3. B 浏览器通过正常 WebSocket 流程收到 → pushToQueue → lamport=1 < 队列 minLamport → 命中"过去"分支
 * 4. 验证 point-collision 事件是否被触发，截图检查红色竖线是否可见
 */
const testLateArrivalRerender = async (browser: any): Promise<TestResult> => {
    console.log('\n══════════════════════════════════════════');
    console.log('  🧪 场景二：迟到数据（"过去"分支）脏区域重绘');
    console.log('══════════════════════════════════════════\n');

    const roomId = generateRoomId();
    await createRoom(roomId, '迟到数据测试');
    const userB = await joinRoom(roomId, 'LateB');
    if (!userB) return { name: '迟到数据', passed: false, details: '无法获取 token' };

    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageB = await ctxB.newPage();

    let rerenderCountB = 0;

    pageB.on('console', (msg: any) => {
        if (msg.text().includes('接收到重绘事件')) rerenderCountB++;
    });

    await setupPage(pageB, userB.token, 'LateB');
    await new Promise(r => setTimeout(r, 2000));

    // 步骤 1：B 画 3 条黑色横线
    console.log('  📈 B 画 3 条黑色横线推高 Lamport 队列水位...');
    await drawLine(pageB, 200, 200, 700, 200, 20, 'B-横线1(y=200)');
    await drawLine(pageB, 200, 350, 700, 350, 20, 'B-横线2(y=350)');
    await drawLine(pageB, 200, 500, 700, 500, 20, 'B-横线3(y=500)');
    await new Promise(r => setTimeout(r, 1000));

    // 步骤 2：用 WebSocket 注入器发送 lamport=1 的红色竖线
    console.log('  🔌 启动 WebSocket 注入器，发送迟到的红色竖线...');
    const injectorUser = await joinRoom(roomId, 'LateInjector');
    if (!injectorUser) return { name: '迟到数据', passed: false, details: '注入器无法加入房间' };

    const injResult = await injectLateCommand(roomId, injectorUser.token, injectorUser.userId);
    console.log(`  📋 注入结果: ${JSON.stringify(injResult)}`);

    // 等待 B 收到并处理
    await new Promise(r => setTimeout(r, 5000));
    await pageB.screenshot({ path: `${CONFIG.SCREENSHOT_DIR}/late_B.png` });

    const passed = rerenderCountB > 0;
    console.log(`  📊 结果: B 重绘事件触发 ${rerenderCountB} 次 ${passed ? '✅' : '❌'}`);

    await ctxB.close();

    return {
        name: '迟到数据（"过去"分支）脏区域重绘',
        passed,
        details: `B 重绘事件触发 ${rerenderCountB} 次, 注入 lamport=${injResult.lamport}`
    };
};

/**
 * 场景三：重绘后双端视觉一致性
 */
const testVisualConsistency = async (browser: any): Promise<TestResult> => {
    console.log('\n══════════════════════════════════════════');
    console.log('  🧪 场景三：重绘后双端数据一致性');
    console.log('══════════════════════════════════════════\n');

    const roomId = generateRoomId();
    await createRoom(roomId, '一致性测试');
    const userA = await joinRoom(roomId, 'ConsA');
    const userB = await joinRoom(roomId, 'ConsB');
    if (!userA || !userB) return { name: '一致性', passed: false, details: '无法获取 token' };

    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    let totalRerenderA = 0;
    let totalRerenderB = 0;

    pageA.on('console', (msg: any) => {
        if (msg.text().includes('接收到重绘事件')) totalRerenderA++;
    });
    pageB.on('console', (msg: any) => {
        if (msg.text().includes('接收到重绘事件')) totalRerenderB++;
    });

    await setupPage(pageA, userA.token, 'ConsA');
    await setupPage(pageB, userB.token, 'ConsB');
    await new Promise(r => setTimeout(r, 2000));

    console.log('  🎨 交替画线形成交叉网格...');

    await drawLine(pageA, 200, 200, 900, 200, 25, 'A-横1');
    await drawLine(pageA, 200, 350, 900, 350, 25, 'A-横2');
    await drawLine(pageA, 200, 500, 900, 500, 25, 'A-横3');

    await new Promise(r => setTimeout(r, 2000));

    await drawLine(pageB, 400, 100, 400, 600, 25, 'B-竖1');
    await drawLine(pageB, 600, 100, 600, 600, 25, 'B-竖2');
    await drawLine(pageB, 800, 100, 800, 600, 25, 'B-竖3');

    console.log('  ⏳ 等待完全同步...');
    await new Promise(r => setTimeout(r, 5000));

    const digestA = await getCommandsDigest(pageA);
    const digestB = await getCommandsDigest(pageB);

    const commandsMatch = (digestA.len === digestB.len && digestA.len > 0 && digestA.ids === digestB.ids);

    await pageA.screenshot({ path: `${CONFIG.SCREENSHOT_DIR}/consistency_A.png` });
    await pageB.screenshot({ path: `${CONFIG.SCREENSHOT_DIR}/consistency_B.png` });

    console.log(`  📊 结果:`);
    console.log(`     A: commands=${digestA.len}, 重绘=${totalRerenderA}次`);
    console.log(`     B: commands=${digestB.len}, 重绘=${totalRerenderB}次`);
    console.log(`     Commands 数据一致: ${commandsMatch ? '✅' : '❌'}`);

    await ctxA.close();
    await ctxB.close();

    return {
        name: '重绘后双端数据一致性',
        passed: commandsMatch,
        details: `A:${digestA.len}条命令/重绘${totalRerenderA}次, B:${digestB.len}条命令/重绘${totalRerenderB}次, 数据一致=${commandsMatch}`
    };
};

// ========== 主流程 ==========

(async () => {
    console.log('═══════════════════════════════════════════════════');
    console.log('  🧪 协同画板 - 脏区域局部重绘 专项测试');
    console.log('═══════════════════════════════════════════════════\n');

    const browser = await chromium.launch({
        headless: false,
        channel: 'chrome',
    });

    const results: TestResult[] = [];

    try {
        results.push(await withTimeout(testCrossCollision(browser), CONFIG.SCENARIO_TIMEOUT_MS, '场景一'));
    } catch (err) {
        console.error('💀 场景一异常:', err);
        results.push({ name: '同 Lamport 交叉碰撞重绘', passed: false, details: `异常: ${err}` });
    }

    try {
        results.push(await withTimeout(testLateArrivalRerender(browser), CONFIG.SCENARIO_TIMEOUT_MS, '场景二'));
    } catch (err) {
        console.error('💀 场景二异常:', err);
        results.push({ name: '迟到数据脏区域重绘', passed: false, details: `异常: ${err}` });
    }

    try {
        results.push(await withTimeout(testVisualConsistency(browser), CONFIG.SCENARIO_TIMEOUT_MS, '场景三'));
    } catch (err) {
        console.error('💀 场景三异常:', err);
        results.push({ name: '重绘后双端数据一致性', passed: false, details: `异常: ${err}` });
    }

    // 汇总报告
    console.log('\n\n═══════════════════════════════════════════════════');
    console.log('  📊 脏区域重绘测试 - 最终报告');
    console.log('═══════════════════════════════════════════════════\n');

    let allPassed = true;
    results.forEach((r, i) => {
        const status = r.passed ? '✅ PASS' : '❌ FAIL';
        console.log(`  [${i + 1}] ${r.name}: ${status}`);
        console.log(`      ${r.details}`);
        if (!r.passed) allPassed = false;
    });

    console.log('\n' + (allPassed
        ? '  🎉 全部测试通过！脏区域重绘机制工作正常！'
        : '  ⚠️  部分测试未通过，请查看上方详情。'));

    console.log(`\n  📸 截图已保存到 ${CONFIG.SCREENSHOT_DIR}/`);
    console.log('\n⏸️  浏览器窗口保持打开，按 Ctrl+C 关闭。');

    await new Promise(() => { });
})();
