/**
 * 协同画板 Benchmark 综合调度中枢 (V2 - 四维硬件矩阵版)
 */

import { chromium, type Browser } from 'playwright';
import { runFullRenderSuite, type FullRenderReport } from './full-render';
import { runLatencySuite, type LatencyReport } from './latency';
import { runStressSuite, type StressReport } from './stress-concurrent';
import { runCollisionSuite, type CollisionReport } from './collision';
import { runChaosSuite, type ChaosReport } from './chaos-network';
import { runVisualConsistencySuite, type VisualConsistencyReport } from './visual-consistency';
import { generateHtmlReport } from './html-reporter';

const SCALES = [10000, 50000, 100000];

interface AggregatedReport {
    fullRender: FullRenderReport[];
    latency?: LatencyReport;
    stress?: StressReport;
    collision?: CollisionReport;
    chaos?: ChaosReport;
    visual?: VisualConsistencyReport;
}

interface PerfResultMap {
    gpu_cpuHigh: AggregatedReport;
    gpu_cpuLow: AggregatedReport;
    noGpu_cpuHigh: AggregatedReport;
    noGpu_cpuLow: AggregatedReport;
}

const printReport = (results: PerfResultMap) => {
    console.log(`\n\n`);
    console.log(`🚀 协同画板综合 Benchmark Report (V2 - 4维硬件组合测试)`);

    // 1. 全量吞吐能力
    console.log(`\n==== 1. 全量吞吐及重绘能力 (Full Render) =====================================================================`);
    console.log(`| 测试量级 | 硬件组合模式 (GPU / CPU)     | Init包大小 | 纯渲染耗时 | 用户感知总用时 | 渲染引擎 TPS | 评价基准线 |`);
    console.log(`|---------:|:----------------------------:|-----------:|-----------:|--------------:|-------------:|:-----------|`);

    const printFrRow = (scaleStr: string, modeName: string, r: FullRenderReport | undefined) => {
        if (!r) return;
        const sizeKb = r.payloadSizeKb;
        const sizeStr = sizeKb > 1024 ? `${(sizeKb / 1024).toFixed(2)} MB` : `${sizeKb.toFixed(1)} KB`;
        const render = `${r.pureRenderMs.toFixed(0)} ms`;
        const total = `${r.totalPerceivedMs.toFixed(0)} ms`;
        const tps = `${(r.throughputTps / 10000).toFixed(1)}万/秒`;
        let status = '✅ 流畅';
        if (r.pureRenderMs > 150) status = '⚠️ 轻微卡顿';
        if (r.pureRenderMs > 400) status = '❌ 明显卡顿';
        if (r.pureRenderMs > 800) status = '💀 灾难卡死';
        console.log(`| ${scaleStr.padStart(8)} | ${modeName.padEnd(28)} | ${sizeStr.padStart(10)} | ${render.padStart(10)} | ${total.padStart(13)} | ${tps.padStart(12)} | ${status} |`);
    };

    for (const scale of SCALES) {
        const scaleStr = scale >= 10000 ? `${scale / 10000}万` : `${scale}`;
        printFrRow(scaleStr, "GPU 开启 + CPU 满血", results.gpu_cpuHigh.fullRender.find(r => r.scale === scale));
        printFrRow("", "GPU 开启 + CPU 降速(4x)", results.gpu_cpuLow.fullRender.find(r => r.scale === scale));
        printFrRow("", "GPU 关闭 + CPU 满血", results.noGpu_cpuHigh.fullRender.find(r => r.scale === scale));
        printFrRow("", "GPU 关闭 + CPU 降速(4x)", results.noGpu_cpuLow.fullRender.find(r => r.scale === scale));
        console.log(`|----------|------------------------------|------------|------------|---------------|--------------|------------|`);
    }

    // 2. 响应性
    console.log(`\n==== 2. 跟手性与端到端同步延迟 (Latency) =======================`);
    console.log(`| 硬件组合模式               | 本地起笔延迟 | 端到端协同延迟 |`);
    console.log(`|:--------------------------|-------------:|--------------:|`);
    const printLatency = (modeName: string, r: LatencyReport | undefined) => {
        if (!r) return;
        console.log(`| ${modeName.padEnd(25)} | ${(r.firstDrawMs).toFixed(0).padStart(8)} ms | ${(r.e2eSyncMs).toFixed(0).padStart(10)} ms |`);
    };
    printLatency("GPU 开启 + CPU 满血", results.gpu_cpuHigh.latency);
    printLatency("GPU 开启 + CPU 降速(4x)", results.gpu_cpuLow.latency);
    printLatency("GPU 关闭 + CPU 满血", results.noGpu_cpuHigh.latency);
    printLatency("GPU 关闭 + CPU 降速(4x)", results.noGpu_cpuLow.latency);

    // 3. 阻塞测试
    console.log(`\n==== 3. 极限并发抗压与渲染稳健度 (Sustained Stress FPS) ====================`);
    console.log(`| 硬件组合模式               | 10s高压维持帧率 | 最长 UI 阻塞黑屏 | 模拟注入总发卡数 | 最终对账通过 |`);
    console.log(`|:--------------------------|----------------:|----------------:|----------------:|------------:|`);
    const printStress = (modeName: string, r: StressReport | undefined) => {
        if (!r) return;
        const pass = r.isConsistent ? '✅ PASS' : '❌ FAIL';
        console.log(`| ${modeName.padEnd(25)} | ${(r.averageFps).toFixed(1).padStart(11)} FPS | ${(r.maxMainThreadBlockMs).toFixed(0).padStart(13)} ms | ${String(r.totalPointsInjected).padStart(16)} | ${pass.padStart(11)} |`);
    };
    printStress("GPU 开启 + CPU 满血", results.gpu_cpuHigh.stress);
    printStress("GPU 开启 + CPU 降速(4x)", results.gpu_cpuLow.stress);
    printStress("GPU 关闭 + CPU 满血", results.noGpu_cpuHigh.stress);
    printStress("GPU 关闭 + CPU 降速(4x)", results.noGpu_cpuLow.stress);

    // 4. 碰撞引擎
    console.log(`\n==== 4. 交叉碰撞检测引擎可靠性 (Collision Auto-Healing) =======`);
    console.log(`| 硬件组合模式               | 通过情况 | 跨端交汇脏区耗时 |`);
    console.log(`|:--------------------------|:--------|----------------:|`);
    const printColl = (modeName: string, r: CollisionReport | undefined) => {
        if (!r) return;
        const pass = r.collisionDetected ? '✅ PASS' : '❌ FAIL';
        console.log(`| ${modeName.padEnd(25)} | ${pass.padEnd(7)} | ${(r.durationMs).toFixed(0).padStart(13)} ms |`);
    };
    printColl("GPU 开启 + CPU 满血", results.gpu_cpuHigh.collision);
    printColl("GPU 开启 + CPU 降速(4x)", results.gpu_cpuLow.collision);
    printColl("GPU 关闭 + CPU 满血", results.noGpu_cpuHigh.collision);
    printColl("GPU 关闭 + CPU 降速(4x)", results.noGpu_cpuLow.collision);

    // 5. 混沌弱网测试
    console.log(`\n==== 5. 混沌仿真弱网恢复 (Chaos Network Emulation) =============`);
    console.log(`| 硬件组合模式               | 脱网惩罚 |   真实恢复耗费   |  数据无损修复  |`);
    console.log(`|:--------------------------|---------:|-----------------:|--------------:|`);
    const printChaos = (modeName: string, r: ChaosReport | undefined) => {
        if (!r) return;
        const pass = r.droppedStateRecovered ? '✅ PASS' : '❌ FAIL';
        console.log(`| ${modeName.padEnd(25)} | ${String(r.targetNetworkMs).padStart(5)} ms | ${(r.actualReconnectionTimeMs).toFixed(0).padStart(13)} ms | ${pass.padStart(13)} |`);
    };
    printChaos("GPU 开启 + CPU 满血", results.gpu_cpuHigh.chaos);
    printChaos("GPU 开启 + CPU 降速(4x)", results.gpu_cpuLow.chaos);
    printChaos("GPU 关闭 + CPU 满血", results.noGpu_cpuHigh.chaos);
    printChaos("GPU 关闭 + CPU 降速(4x)", results.noGpu_cpuLow.chaos);

    // 6. 视觉一致性鉴权
    console.log(`\n==== 6. 像素级终态视觉绝对对账 (Pixel-Perfect Auth) ============`);
    console.log(`| 硬件组合模式               | 后进门历史拉取画面吻合 | 并发麻花线遮挡叠加吻合 |`);
    console.log(`|:--------------------------|:---------------------:|:---------------------:|`);
    const printVisual = (modeName: string, r: VisualConsistencyReport | undefined) => {
        if (!r) return;
        const pass1 = r.lateJoinerMatched ? '✅ ISOMORPHIC' : '❌ DIFF';
        const pass2 = r.concurrentCrossingMatched ? '✅ ISOMORPHIC' : '❌ FAIL(Z-INDEX)';
        console.log(`| ${modeName.padEnd(25)} | ${pass1.padStart(21)} | ${pass2.padStart(21)} |`);
    };
    printVisual("GPU 开启 + CPU 满血", results.gpu_cpuHigh.visual);
    printVisual("GPU 开启 + CPU 降速(4x)", results.gpu_cpuLow.visual);
    printVisual("GPU 关闭 + CPU 满血", results.noGpu_cpuHigh.visual);
    printVisual("GPU 关闭 + CPU 降速(4x)", results.noGpu_cpuLow.visual);

    console.log('\n');
};

(async () => {
    console.log('🔄 启动 协同画板 V3 Runner (全维度·矩阵测试) ...');

    // 初始化结果集
    const results: PerfResultMap = {
        gpu_cpuHigh: { fullRender: [] },
        gpu_cpuLow: { fullRender: [] },
        noGpu_cpuHigh: { fullRender: [] },
        noGpu_cpuLow: { fullRender: [] }
    };

    const runScenario = async (browser: Browser, throttleCpu: boolean, target: AggregatedReport, desc: string) => {
        console.log(`\n======================================================`);
        console.log(`[当前测试环境] ${desc}`);
        console.log(`======================================================`);

        console.log(`  -> 正在运行 [1/6] FullRender Suite`);
        target.fullRender = [];
        for (const scale of SCALES) {
            console.log(`     - 量级: ${scale}`);
            try { target.fullRender.push(await runFullRenderSuite(scale, browser, throttleCpu)); } catch (e) { console.error('FullRender fail', e); }
            await new Promise(r => setTimeout(r, 1000));
        }

        console.log(`  -> 正在运行 [2/6] Latency Suite`);
        try { target.latency = await runLatencySuite(browser, throttleCpu); } catch (e) { console.error('Latency fail: ', e); }

        console.log(`  -> 正在运行 [3/6] Stress Concurrent Suite`);
        try { target.stress = await runStressSuite(browser, throttleCpu); } catch (e) { console.error('Stress fail: ', e); }

        console.log(`  -> 正在运行 [4/6] Collision Auto-Healing Suite`);
        try { target.collision = await runCollisionSuite(browser, throttleCpu); } catch (e) { console.error('Collision fail: ', e); }

        console.log(`  -> 正在运行 [5/6] Chaos Network Emulation Suite`);
        try { target.chaos = await runChaosSuite(browser, throttleCpu); } catch (e) { console.error('Chaos fail: ', e); }

        console.log(`  -> 正在运行 [6/6] Visual Consistency Pixel Engine`);
        try { target.visual = await runVisualConsistencySuite(browser, throttleCpu); } catch (e) { console.error('Visual fail: ', e); }
    };

    // 1. GPU 开启的浏览器
    console.log(`\n\n>>> 正在挂载浏览器环境: GPU 硬件加速 [开启]`);
    const browserGpuOn = await chromium.launch({ headless: true, channel: 'chrome' });
    await runScenario(browserGpuOn, false, results.gpu_cpuHigh, "GPU 开启 + CPU 满血");
    await runScenario(browserGpuOn, true, results.gpu_cpuLow, "GPU 开启 + CPU 降速(4x)");
    await browserGpuOn.close();

    // 2. GPU 关闭的浏览器
    console.log(`\n\n>>> 正在挂载浏览器环境: GPU 硬件加速 [彻底关闭/软渲染]`);
    const browserGpuOff = await chromium.launch({
        headless: true,
        channel: 'chrome',
        args: [
            '--disable-gpu',
            '--disable-gpu-compositing',
            '--disable-gpu-rasterization',
            '--disable-accelerated-2d-canvas',
        ]
    });
    await runScenario(browserGpuOff, false, results.noGpu_cpuHigh, "GPU 关闭 + CPU 满血");
    await runScenario(browserGpuOff, true, results.noGpu_cpuLow, "GPU 关闭 + CPU 降速(4x)");
    await browserGpuOff.close();

    // 3. 产生最终报表
    printReport(results);
    generateHtmlReport(results);

    process.exit(0);
})();
