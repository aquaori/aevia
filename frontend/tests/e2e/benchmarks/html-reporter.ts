import fs from 'fs';
import path from 'path';

export const generateHtmlReport = (results: any) => {
    const reportDir = path.join(process.cwd(), 'tests', 'e2e', 'benchmarks', 'reports');
    if (!fs.existsSync(reportDir)) {
        fs.mkdirSync(reportDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/T/, '_').replace(/:/g, '-').split('.')[0];
    const fileName = `benchmark-v4-${timestamp}.html`;
    const destPath = path.join(reportDir, fileName);

    const safeMap = (arr: any[], mapper: (val: any) => any) => arr ? arr.map(mapper) : [];
    const getSafe = (obj: any, key: string, fallback: any = 0) => obj && obj[key] !== undefined ? obj[key] : fallback;

    const scales = safeMap(results.gpu_cpuHigh.fullRender, (r: any) => r.scale);

    // 渲染耗时折线图
    const renderData = {
        gpu_cpuHigh: safeMap(results.gpu_cpuHigh.fullRender, (r: any) => r.pureRenderMs),
        gpu_cpuLow: safeMap(results.gpu_cpuLow.fullRender, (r: any) => r.pureRenderMs),
        noGpu_cpuHigh: safeMap(results.noGpu_cpuHigh.fullRender, (r: any) => r.pureRenderMs),
        noGpu_cpuLow: safeMap(results.noGpu_cpuLow.fullRender, (r: any) => r.pureRenderMs),
    };

    // 内存增长曲线
    const memoryData = {
        gpu_cpuHigh: safeMap(results.gpu_cpuHigh.fullRender, (r: any) => r.memoryUsageMb),
        gpu_cpuLow: safeMap(results.gpu_cpuLow.fullRender, (r: any) => r.memoryUsageMb),
        noGpu_cpuHigh: safeMap(results.noGpu_cpuHigh.fullRender, (r: any) => r.memoryUsageMb),
        noGpu_cpuLow: safeMap(results.noGpu_cpuLow.fullRender, (r: any) => r.memoryUsageMb),
    };

    // Latency 并排柱状图
    const latencyData = {
        firstDrawMs: [
            getSafe(results.gpu_cpuHigh.latency, 'firstDrawMs'),
            getSafe(results.gpu_cpuLow.latency, 'firstDrawMs'),
            getSafe(results.noGpu_cpuHigh.latency, 'firstDrawMs'),
            getSafe(results.noGpu_cpuLow.latency, 'firstDrawMs'),
        ],
        e2eSyncMs: [
            getSafe(results.gpu_cpuHigh.latency, 'e2eSyncMs'),
            getSafe(results.gpu_cpuLow.latency, 'e2eSyncMs'),
            getSafe(results.noGpu_cpuHigh.latency, 'e2eSyncMs'),
            getSafe(results.noGpu_cpuLow.latency, 'e2eSyncMs'),
        ]
    };

    // Stress 洪峰气泡特征
    const stressData = {
        blocks: [
            getSafe(results.gpu_cpuHigh.stress, 'maxMainThreadBlockMs'),
            getSafe(results.gpu_cpuLow.stress, 'maxMainThreadBlockMs'),
            getSafe(results.noGpu_cpuHigh.stress, 'maxMainThreadBlockMs'),
            getSafe(results.noGpu_cpuLow.stress, 'maxMainThreadBlockMs'),
        ],
        fps: [
            getSafe(results.gpu_cpuHigh.stress, 'averageFps'),
            getSafe(results.gpu_cpuLow.stress, 'averageFps'),
            getSafe(results.noGpu_cpuHigh.stress, 'averageFps'),
            getSafe(results.noGpu_cpuLow.stress, 'averageFps'),
        ]
    };

    // Chaos
    const chaosData = {
        recoverTime: [
            getSafe(results.gpu_cpuHigh.chaos, 'actualReconnectionTimeMs'),
            getSafe(results.gpu_cpuLow.chaos, 'actualReconnectionTimeMs'),
            getSafe(results.noGpu_cpuHigh.chaos, 'actualReconnectionTimeMs'),
            getSafe(results.noGpu_cpuLow.chaos, 'actualReconnectionTimeMs'),
        ]
    };

    // 一致性对账 (来自 Stress 末尾)
    const consistentResults = [
        getSafe(results.gpu_cpuHigh.stress, 'isConsistent', false),
        getSafe(results.gpu_cpuLow.stress, 'isConsistent', false),
        getSafe(results.noGpu_cpuHigh.stress, 'isConsistent', false),
        getSafe(results.noGpu_cpuLow.stress, 'isConsistent', false),
    ];

    // 视觉像素对账 (V4 新增)
    const visualLateJoiner = [
        getSafe(results.gpu_cpuHigh.visual, 'lateJoinerMatched', false),
        getSafe(results.gpu_cpuLow.visual, 'lateJoinerMatched', false),
        getSafe(results.noGpu_cpuHigh.visual, 'lateJoinerMatched', false),
        getSafe(results.noGpu_cpuLow.visual, 'lateJoinerMatched', false),
    ];
    const visualConcurrent = [
        getSafe(results.gpu_cpuHigh.visual, 'concurrentCrossingMatched', false),
        getSafe(results.gpu_cpuLow.visual, 'concurrentCrossingMatched', false),
        getSafe(results.noGpu_cpuHigh.visual, 'concurrentCrossingMatched', false),
        getSafe(results.noGpu_cpuLow.visual, 'concurrentCrossingMatched', false),
    ];

    const htmlContent = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>协同画板 Benchmark 综合性能报表 (V4 Pro Max)</title>
    <script src="https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    colors: {
                        primary: '#3b82f6',
                        slate: { 850: '#152033' }
                    }
                }
            }
        }
    </script>
    <style>
        body { background-color: #f8fafc; color: #0f172a; font-family: 'Inter', -apple-system, system-ui, sans-serif; }
        .glass-card { background: rgba(255, 255, 255, 0.98); border: 1px solid #e2e8f0; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03); transition: all 0.2s; }
        .glass-card:hover { box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.08), 0 4px 6px -2px rgba(0, 0, 0, 0.04); transform: translateY(-2px); }
        .chart-container { width: 100%; height: 350px; }
        .table-container { width: 100%; overflow-x: auto; margin-top: 1.5rem; border: 1px solid #f1f5f9; border-radius: 0.5rem; }
        table { width: 100%; text-align: left; border-collapse: collapse; font-size: 0.875rem; }
        th { background-color: #f8fafc; padding: 0.875rem 1rem; color: #475569; font-weight: 600; border-bottom: 2px solid #e2e8f0; white-space: nowrap; }
        td { padding: 0.875rem 1rem; border-bottom: 1px solid #e2e8f0; color: #334155; }
        tr:last-child td { border-bottom: none; }
        .badge { display: inline-flex; align-items: center; padding: 0.25rem 0.625rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; }
        .badge-success { background-color: #dcfce7; color: #166534; }
        .badge-error { background-color: #fee2e2; color: #991b1b; }
    </style>
</head>
<body class="p-4 md:p-8">
    <div class="max-w-7xl mx-auto space-y-8">
        
        <!-- Header -->
        <header class="glass-card p-6 md:p-10 text-center relative overflow-hidden">
            <div class="absolute inset-0 opacity-10 bg-gradient-to-r from-blue-500 to-indigo-600"></div>
            <h1 class="text-3xl md:text-5xl font-extrabold text-slate-900 tracking-tight leading-tight relative z-10 block">
                协同画板指令级 CRDT 压测白皮书
            </h1>
            <div class="inline-block mt-3 px-3 py-1 bg-indigo-100 text-indigo-700 font-bold rounded-lg text-lg z-10 relative">
                Benchmark V4 Pro Max
            </div>
            <p class="mt-4 text-slate-600 max-w-2xl mx-auto relative z-10 text-sm md:text-base leading-relaxed">
                全维度考察“时序锁”、“视觉像素拦截”、“脏区收敛矩阵”的性能沙盘。包含双向四维度的网闸/硬件限速测试群！
            </p>
            <div class="mt-6 inline-flex items-center gap-2 px-4 py-2 bg-slate-100/80 rounded-full text-xs md:text-sm font-medium text-slate-500 relative z-10 border border-slate-200">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                测试归档时间：${new Date().toLocaleString()}
            </div>
        </header>

        <!-- 一致性与正确性审判台 -->
        <section class="glass-card p-6 border-l-4 border-l-indigo-500">
            <div class="flex items-start gap-4 mb-4">
                <div class="p-2.5 bg-indigo-100 rounded-lg text-indigo-600 shrink-0">
                    <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>
                </div>
                <div>
                    <h2 class="text-xl font-bold text-slate-900 mb-1">多端数据与视觉一致性大审判 (100% 严苛防线)</h2>
                    <p class="text-xs md:text-sm text-slate-500 max-w-4xl">
                        若此处出现任何 “❌ FAIL”，代表不同客户端的屏幕上出现了由于遮挡重叠、网络掉包或乱序复读引发的状态不一致和脏数据幻觉。
                    </p>
                </div>
            </div>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th class="w-1/5">测评组合环境</th>
                            <th class="w-1/5 bg-slate-50/50">Chaos 极限脱网自愈<br/><span class="text-xs text-slate-400 font-normal">500ms恢复率</span></th>
                            <th class="w-1/5 bg-slate-50/50">底层内存 Hash 对账<br/><span class="text-xs text-slate-400 font-normal">验证数组序列长度无漏</span></th>
                            <th class="w-1/5 bg-indigo-50/30 text-indigo-800">晚进场像素追平<br/><span class="text-xs text-indigo-400 font-normal">Canvas Base64 切片盲测</span></th>
                            <th class="w-1/5 bg-indigo-50/30 text-indigo-800">并发相交涂鸦视觉比对<br/><span class="text-xs text-indigo-400 font-normal">遮挡脏矩形 100% 同构验证</span></th>
                        </tr>
                    </thead>
                    <tbody id="consistencyTableBody"></tbody>
                </table>
            </div>
        </section>

        <!-- 图表网格：每行两个卡片 -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
            
            <!-- Render Latency -->
            <div class="glass-card p-6 flex flex-col">
                <div class="mb-4">
                    <h3 class="text-lg font-bold text-slate-900 mb-1 flex items-center gap-2">
                        <svg class="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path></svg>
                        O(N) 全量历史重载耗时 (Render Latency)
                    </h3>
                    <p class="text-sm text-slate-500">拉取服务器的上万条线段并重新上屏需要多久？<strong class="text-blue-600">低于16ms可保持60fps流畅</strong>。越高代表大体量下越卡顿。</p>
                </div>
                <div id="renderChart" class="chart-container"></div>
                <div class="table-container mt-auto">
                    <table>
                        <thead><tr><th>环境</th><th>1万点</th><th>5万点</th><th>10万点</th></tr></thead>
                        <tbody id="renderTableBody"></tbody>
                    </table>
                </div>
            </div>

            <!-- Memory -->
            <div class="glass-card p-6 flex flex-col">
                <div class="mb-4">
                    <h3 class="text-lg font-bold text-slate-900 mb-1 flex items-center gap-2">
                        <svg class="w-5 h-5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
                        V8 Heap 内存驻留飙升迹象 (Anti-Leak)
                    </h3>
                    <p class="text-sm text-slate-500">测试命令队列在含有 10 万以上关键点时，JS 垃圾回收后的堆常驻空间（MB）。理想状态为非线性平缓上扬。</p>
                </div>
                <div id="memoryChart" class="chart-container"></div>
                <div class="table-container mt-auto">
                    <table>
                        <thead><tr><th>环境</th><th>1万点常驻</th><th>5万点常驻</th><th>10万点常驻</th></tr></thead>
                        <tbody id="memoryTableBody"></tbody>
                    </table>
                </div>
            </div>

            <!-- Latency -->
            <div class="glass-card p-6 flex flex-col">
                <div class="mb-4">
                    <h3 class="text-lg font-bold text-slate-900 mb-1 flex items-center gap-2">
                        <svg class="w-5 h-5 text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                        操作响应延迟 (FirstDraw vs E2E Sync)
                    </h3>
                    <p class="text-sm text-slate-500">测试远程命令从发出到接收过程中双端各自的渲染延迟，离坐标轴越近，操作越跟手。</p>
                </div>
                <div id="latencyChart" class="chart-container"></div>
                <div class="table-container mt-auto">
                    <table>
                        <thead><tr><th>环境</th><th>本地渲染跟手性 (ms)</th><th>跨端分发展示均值 (ms)</th></tr></thead>
                        <tbody id="latencyTableBody"></tbody>
                    </table>
                </div>
            </div>

            <!-- Stress -->
            <div class="glass-card p-6 flex flex-col">
                <div class="mb-4">
                    <h3 class="text-lg font-bold text-slate-900 mb-1 flex items-center gap-2">
                        <svg class="w-5 h-5 text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                        高并发前台抗压
                    </h3>
                    <p class="text-sm text-slate-500">20 名并发活体用户在 10 秒内连续以 60Hz 手速投递曲线。观察平均运行 FPS 及极值假死。</p>
                </div>
                <div id="stressChart" class="chart-container"></div>
                <div class="table-container mt-auto">
                    <table>
                        <thead><tr><th>环境</th><th>页面UI最长阻塞期 (ms)</th><th>抗压持续渲染均值 (FPS)</th></tr></thead>
                        <tbody id="stressTableBody"></tbody>
                    </table>
                </div>
            </div>

        </div>
    </div>

    <!-- 数据源挂载与渲染侧逻辑 -->
    <script>
        const labels = ['开启GPU+CPU满频', '开启GPU+CPU4x降频', '关闭GPU+CPU满频', '关闭GPU+CPU4x降频'];
        const chaosTimes = ${JSON.stringify(chaosData.recoverTime)};
        const consRes = ${JSON.stringify(consistentResults)};
        const visLateRes = ${JSON.stringify(visualLateJoiner)};
        const visCrossRes = ${JSON.stringify(visualConcurrent)};
        
        // --- 1. 注入一致性大表格明细 ---
        let htmlcons = '';
        for(let i=0; i<4; i++) {
            const passChaos = chaosTimes[i] > 0 ? \`<span class="badge badge-success">✅ \${chaosTimes[i].toFixed(0)}ms</span>\` : '<span class="badge badge-error">❌ LOST</span>';
            const passCons  = consRes[i] ? '<span class="badge badge-success">✅ SYNC</span>' : '<span class="badge badge-error">❌ BROKEN</span>';
            const passVLate = visLateRes[i] ? '<span class="badge badge-success">🎯 100% 像素等效</span>' : '<span class="badge badge-error">❌ 对账分歧</span>';
            const passVCross= visCrossRes[i] ? '<span class="badge badge-success">⚔️ 完美抗压</span>' : '<span class="badge badge-error">❌ Z值紊乱</span>';
            
            htmlcons += \`<tr>
                <td class="font-medium text-slate-700">\${labels[i]}</td>
                <td class="bg-slate-50/50">\${passChaos}</td>
                <td class="bg-slate-50/50">\${passCons}</td>
                <td class="bg-indigo-50/30">\${passVLate}</td>
                <td class="bg-indigo-50/30">\${passVCross}</td>
            </tr>\`;
        }
        document.getElementById('consistencyTableBody').innerHTML = htmlcons;

        // --- 数据提取助手 ---
        const renderD = ${JSON.stringify(renderData)};
        const memoryD = ${JSON.stringify(memoryData)};
        const latD = ${JSON.stringify(latencyData)};
        const stressD = ${JSON.stringify(stressData)};

        // --- 2. 注入各个小数据表格 ---
        const rKeys = ['gpu_cpuHigh', 'gpu_cpuLow', 'noGpu_cpuHigh', 'noGpu_cpuLow'];
        const formatTbl = (dataObj, isFloat=false) => {
            let trs = '';
            for(let i=0; i<4; i++) {
                const row = dataObj[rKeys[i]];
                trs += \`<tr>
                    <td class="font-medium">\${labels[i]}</td>
                    <td>\${row[0] !== undefined ? (isFloat ? row[0].toFixed(1) : row[0]) : '-'}</td>
                    <td>\${row[1] !== undefined ? (isFloat ? row[1].toFixed(1) : row[1]) : '-'}</td>
                    <td>\${row[2] !== undefined ? (isFloat ? row[2].toFixed(1) : row[2]) : '-'}</td>
                </tr>\`;
            }
            return trs;
        };
        const formatCols = (arrs) => {
            let trs = '';
            for(let i=0; i<4; i++) {
                trs += \`<tr>
                    <td class="font-medium">\${labels[i]}</td>
                    <td>\${arrs[0][i] != null ? arrs[0][i].toFixed(1) : '-'}</td>
                    <td>\${arrs[1][i] != null ? arrs[1][i].toFixed(1) : '-'}</td>
                </tr>\`;
            }
            return trs;
        };

        document.getElementById('renderTableBody').innerHTML = formatTbl(renderD, true);
        document.getElementById('memoryTableBody').innerHTML = formatTbl(memoryD, true);
        document.getElementById('latencyTableBody').innerHTML = formatCols([latD.firstDrawMs, latD.e2eSyncMs]);
        document.getElementById('stressTableBody').innerHTML = formatCols([stressD.blocks, stressD.fps]);


        // --- 3. 驱动 ECharts ---
        const commonGrid = { left: '3%', right: '4%', bottom: '5%', top: '15%', containLabel: true };
        const scalesLabel = ${JSON.stringify(scales)}.map(s => s/1000 + 'k点');

        // Render Latency (折线)
        const renderChart = echarts.init(document.getElementById('renderChart'));
        renderChart.setOption({
            color: ['#10b981', '#fbbf24', '#f43f5e', '#6366f1'], tooltip: { trigger: 'axis' },
            legend: { data: labels, top: 0, right: 0, textStyle: { fontSize: 12 } },
            grid: commonGrid,
            xAxis: { type: 'category', boundaryGap: false, data: scalesLabel, splitLine: { show: true, lineStyle:{color:'#f1f5f9'} } },
            yAxis: { type: 'value', name: 'ms', splitLine: { lineStyle:{color:'#f1f5f9'} } },
            series: rKeys.map((k, idx) => ({ name: labels[idx], type: 'line', data: renderD[k], smooth: true, symbolSize: 6, lineStyle: {width: 3} }))
        });

        // Memory (平滑折线)
        const memoryChart = echarts.init(document.getElementById('memoryChart'));
        memoryChart.setOption({
            color: ['#0ea5e9', '#8b5cf6', '#ec4899', '#f97316'], tooltip: { trigger: 'axis' },
            legend: { data: labels, top: 0, right: 0, textStyle: { fontSize: 12 } },
            grid: commonGrid,
            xAxis: { type: 'category', boundaryGap: false, data: scalesLabel, splitLine: { show: true, lineStyle:{color:'#f1f5f9'} } },
            yAxis: { type: 'value', name: 'MB驻留', splitLine: { lineStyle:{color:'#f1f5f9'} } },
            series: rKeys.map((k, idx) => ({ name: labels[idx], type: 'line', data: memoryD[k], smooth: true, areaStyle: {opacity: 0.05}, symbolSize: 6 }))
        });

        // Latency (并排高定柱状图)
        const latencyChart = echarts.init(document.getElementById('latencyChart'));
        latencyChart.setOption({
            color: ['#0284c7', '#818cf8'], tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
            legend: { data: ['本机(local)', '协同(E2E)'], top: 0, right: 0, textStyle: {fontSize: 12} },
            grid: { left: '3%', right: '4%', bottom: '5%', top: '15%', containLabel: true },
            xAxis: { type: 'category', data: labels, axisLabel: { interval: 0, rotate: 15, fontSize: 10 } },
            yAxis: { type: 'value', name: '耗时 (ms)', splitLine: { lineStyle:{color:'#f1f5f9', type: 'dashed'} } },
            series: [
                { name: '本机(local)', type: 'bar', data: latD.firstDrawMs, barGap: '10%' },
                { name: '协同(E2E)', type: 'bar', data: latD.e2eSyncMs }
            ]
        });

        // Stress (卡死与掉帧的双轴图)
        const stressChart = echarts.init(document.getElementById('stressChart'));
        stressChart.setOption({
            color: ['#f43f5e', '#10b981'], tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
            legend: { data: ['最长锁屏期 (ms)', '抗压均值 (FPS)'], top: 0, right: 0 },
            grid: { left: '3%', right: '4%', bottom: '5%', top: '15%', containLabel: true },
            xAxis: { type: 'category', data: labels, axisLabel: { interval: 0, rotate: 15, fontSize: 10 } },
            yAxis: [
                { type: 'value', name: 'UI被阻塞', position: 'left', splitLine: { lineStyle:{color:'#f1f5f9'} } },
                { type: 'value', name: '平均流畅度', position: 'right', max: 65, splitLine: { show: false } }
            ],
            series: [
                { name: '最长锁屏期 (ms)', type: 'bar', data: stressD.blocks, itemStyle: { opacity: 0.8, borderRadius: [4, 4, 0, 0] } },
                { name: '抗压均值 (FPS)', type: 'line', yAxisIndex: 1, data: stressD.fps, smooth: true, symbolSize: 8, lineStyle: {width: 3} }
            ]
        });

        window.addEventListener('resize', () => {
            renderChart.resize(); memoryChart.resize();
            latencyChart.resize(); stressChart.resize();
        });
    </script>
</body>
</html>
    `;

    fs.writeFileSync(destPath, htmlContent, 'utf-8');
    console.log(`\n🎉 高维复合可视化报告 (V4 Pro Max) 已生成：${destPath}`);
    return destPath;
};
