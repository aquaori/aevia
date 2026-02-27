/**
 * 协同画板 - 多用户碰撞检测自动化测试
 * 
 * 功能说明：
 *   模拟两个用户在同一个房间内同时画出交叉线段，
 *   验证 lamportStore 的哨兵队列是否能正确检测到碰撞并触发脏矩形重绘事件。
 * 
 * 运行方式：
 *   npx tsx tests/e2e/collision-test.ts
 * 
 * 前置条件：
 *   1. 后端服务已启动（默认 http://192.168.10.102:4646）
 *   2. 前端 dev server 已启动（默认 http://localhost:5173）
 *   3. 已安装 Playwright 浏览器：
 *      set PLAYWRIGHT_DOWNLOAD_HOST=https://registry.npmmirror.com/-/binary/playwright
 *      npx playwright install chromium
 */

import { chromium, type Page, type BrowserContext } from 'playwright';

// ========== 配置区 ==========
const CONFIG = {
    API_URL: 'http://192.168.10.102:4646',
    FRONTEND_URL: 'http://localhost:5173',
    ROOM_ID: '',        // 留空则自动创建
    ROOM_NAME: '碰撞检测测试房间',
    ROOM_PASSWORD: '',
    USER_A_NAME: '测试用户A',
    USER_B_NAME: '测试用户B',
    // 画线参数
    DRAW_STEPS: 40,     // 每条线的步数（越多越慢越精确）
    STEP_DELAY_MS: 20,  // 每步间隔（模拟真实画笔速度）
};

// ========== 工具函数 ==========

/** 生成随机6位房间号 */
const generateRoomId = (): string => {
    return String(Math.floor(100000 + Math.random() * 900000));
};

/** 通过 API 创建房间 */
const createRoom = async (roomId: string): Promise<boolean> => {
    try {
        const res = await fetch(`${CONFIG.API_URL}/create-room`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                roomId,
                roomName: CONFIG.ROOM_NAME,
                password: CONFIG.ROOM_PASSWORD,
            }),
        });
        const data = await res.json();
        if (data.code === 200) {
            console.log(`✅ 房间 ${roomId} 创建成功`);
            return true;
        } else {
            console.error(`❌ 房间创建失败: ${data.msg}`);
            return false;
        }
    } catch (err) {
        console.error('❌ 创建房间请求失败:', err);
        return false;
    }
};

/** 通过 API 加入房间，获取 token */
const joinRoom = async (roomId: string, userName: string): Promise<string | null> => {
    try {
        const res = await fetch(`${CONFIG.API_URL}/join-room`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                roomId,
                userName,
                password: CONFIG.ROOM_PASSWORD,
            }),
        });
        const data = await res.json();
        if (data.code === 200) {
            console.log(`✅ ${userName} 加入房间成功，token: ${data.data.token.substring(0, 16)}...`);
            return data.data.token;
        } else {
            console.error(`❌ ${userName} 加入房间失败: ${data.msg}`);
            return null;
        }
    } catch (err) {
        console.error(`❌ ${userName} 加入房间请求失败:`, err);
        return null;
    }
};

/** 
 * 在浏览器页面中注入 token 和用户名到 storage，
 * 然后导航到房间页面 
 */
const setupPageWithToken = async (page: Page, token: string, userName: string): Promise<void> => {
    // 先导航到首页，以便能操作该域名下的 storage
    await page.goto(CONFIG.FRONTEND_URL);

    // 注入 Pinia persisted state 到 sessionStorage + localStorage
    await page.evaluate(({ t, name }: { t: string; name: string }) => {
        // Pinia persist: userStore 存在 sessionStorage
        sessionStorage.setItem('user', JSON.stringify({
            token: t,
            userId: '',
            username: name,
        }));
        // RoomView 通过 localStorage.getItem("wb_username") 检查用户名
        // 如果缺失会弹出名字输入弹窗，阻塞测试流程
        localStorage.setItem('wb_username', name);
    }, { t: token, name: userName });

    // 导航到房间
    await page.goto(`${CONFIG.FRONTEND_URL}/room`);

    // 等待 Canvas 元素加载完成
    await page.waitForSelector('canvas', { timeout: 15000 });
    console.log('  📐 Canvas 已加载');

    // 额外等 WebSocket 连接建立
    await page.waitForTimeout(2000);
};

/** 在指定页面上模拟画线 */
const drawLine = async (
    page: Page,
    startX: number, startY: number,
    endX: number, endY: number,
    steps: number = CONFIG.DRAW_STEPS,
    label: string = ''
): Promise<void> => {
    console.log(`  🖊️ ${label} 开始画线: (${startX},${startY}) → (${endX},${endY})，共 ${steps} 步`);

    // 移动到起点
    await page.mouse.move(startX, startY);
    // 按下鼠标（模拟 pointerdown）
    await page.mouse.down();

    // 沿轨迹逐步移动（模拟 pointermove）
    for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        const x = startX + (endX - startX) * progress;
        const y = startY + (endY - startY) * progress;
        await page.mouse.move(x, y);
        await page.waitForTimeout(CONFIG.STEP_DELAY_MS);
    }

    // 松开鼠标（模拟 pointerup）
    await page.mouse.up();
    console.log(`  ✅ ${label} 画线完成`);
};

// ========== 主流程 ==========

(async () => {
    console.log('═══════════════════════════════════════════════');
    console.log('  🧪 协同画板 - 碰撞检测自动化测试');
    console.log('═══════════════════════════════════════════════\n');

    // 1. 准备房间
    const roomId = CONFIG.ROOM_ID || generateRoomId();
    console.log(`📦 房间号: ${roomId}`);

    const created = await createRoom(roomId);
    if (!created) {
        console.error('💀 无法创建房间，测试中止。');
        process.exit(1);
    }

    // 2. 两个用户分别获取 token
    const tokenA = await joinRoom(roomId, CONFIG.USER_A_NAME);
    const tokenB = await joinRoom(roomId, CONFIG.USER_B_NAME);

    if (!tokenA || !tokenB) {
        console.error('💀 无法获取 token，测试中止。');
        process.exit(1);
    }

    // 3. 启动浏览器
    console.log('\n🚀 启动浏览器...');
    const browser = await chromium.launch({
        headless: false,   // 有头模式，方便观察
        slowMo: 50,        // 稍微放慢操作，便于肉眼观察
        channel: 'chrome', // 使用系统已安装的 Chrome，无需下载 Playwright 专用 Chromium
    });

    // 创建两个独立的上下文（相当于两个隔身窗口，互不共享 Cookie/Session）
    const contextA: BrowserContext = await browser.newContext({
        viewport: { width: 1280, height: 720 },
    });
    const contextB: BrowserContext = await browser.newContext({
        viewport: { width: 1280, height: 720 },
    });

    const pageA: Page = await contextA.newPage();
    const pageB: Page = await contextB.newPage();

    // 4. 监听控制台输出
    let collisionDetectedA = false;
    let collisionDetectedB = false;

    pageA.on('console', msg => {
        const text = msg.text();
        console.log(`  [A 控制台]: ${text}`);
        if (text.includes('需要重绘') || text.includes('接收到重绘事件')) {
            collisionDetectedA = true;
        }
    });

    pageB.on('console', msg => {
        const text = msg.text();
        console.log(`  [B 控制台]: ${text}`);
        if (text.includes('需要重绘') || text.includes('接收到重绘事件')) {
            collisionDetectedB = true;
        }
    });

    // 5. 进入房间
    console.log('\n📡 用户 A 进入房间...');
    await setupPageWithToken(pageA, tokenA, CONFIG.USER_A_NAME);

    console.log('📡 用户 B 进入房间...');
    await setupPageWithToken(pageB, tokenB, CONFIG.USER_B_NAME);

    // 6. 等待所有 WebSocket 都稳定
    console.log('\n⏳ 等待 WebSocket 建立和同步...');
    await new Promise(r => setTimeout(r, 3000));

    // 7. 同时画交叉线！
    console.log('\n═══════════════════════════════════════════════');
    console.log('  🎯 开始同时画交叉线（X形对角线）');
    console.log('═══════════════════════════════════════════════\n');

    // 用户A：从中心偏左(500,300) 画到中心偏右(700,400) —— 短线段 ↘
    // 用户B：从中心偏右(700,300) 画到中心偏左(500,400) —— 短线段 ↙
    // 短距离交叉！两条线从一开始就在彼此附近，几步之内必定交叉！

    await Promise.all([
        drawLine(pageA, 500, 300, 700, 400, CONFIG.DRAW_STEPS, '用户A'),
        drawLine(pageB, 700, 300, 500, 400, CONFIG.DRAW_STEPS, '用户B'),
    ]);

    // 8. 等待网络同步完成
    console.log('\n⏳ 等待同步和碰撞检测...');
    await new Promise(r => setTimeout(r, 5000));

    // 9. 报告结果
    console.log('\n═══════════════════════════════════════════════');
    console.log('  📊 测试结果');
    console.log('═══════════════════════════════════════════════');
    console.log(`  用户 A 检测到碰撞: ${collisionDetectedA ? '✅ 是' : '❌ 否'}`);
    console.log(`  用户 B 检测到碰撞: ${collisionDetectedB ? '✅ 是' : '❌ 否'}`);

    if (collisionDetectedA || collisionDetectedB) {
        console.log('\n  🎉 碰撞检测测试通过！哨兵队列工作正常！');
    } else {
        console.log('\n  ⚠️ 未检测到碰撞。可能原因：');
        console.log('     - 网络延迟导致两条线的 Lamport 时间戳完全错开（落入"归档"分支）');
        console.log('     - Canvas 坐标偏移导致线段实际未交叉');
        console.log('     - 画速太慢，两人的笔画在时间上完全串行化了');
        console.log('  💡 建议：减少 STEP_DELAY_MS 或增大 DRAW_STEPS，让两者尽量密集并行');
    }

    // 10. 截图保存
    console.log('\n📸 保存截图...');
    await pageA.screenshot({ path: 'tests/e2e/screenshots/userA_result.png', fullPage: false });
    await pageB.screenshot({ path: 'tests/e2e/screenshots/userB_result.png', fullPage: false });
    console.log('  截图已保存到 tests/e2e/screenshots/ 目录');

    // 11. 等待用户查看，不自动关闭
    console.log('\n⏸️  测试完成！浏览器窗口保持打开，按 Ctrl+C 关闭。');

    // 保持进程运行，让用户可以肉眼查看画板
    await new Promise(() => { });
})();
