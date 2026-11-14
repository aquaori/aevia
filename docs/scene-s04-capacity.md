# S04 大场景诊断记录

2026-11-14 在集成代码 `b7467c8` 上运行已有的 `boundary-full-render-until-crash` 单项诊断。每个规模使用独立临时 SQLite、后端和前端进程，数据由协议驱动器生成；运行结束后由工具清理。环境：Windows 11、Ryzen 9 5900HX、Chromium 157（headless）、1280×720、GPU on、CPU 1×。每档一次，未将结果写入性能基线。

| 点数 | 结果 | 房间加载时间 | 页面主线程 JS 堆（观测值） | Run ID |
| --- | --- | --- | --- | --- |
| 100,000 | 完成 | 1.34 s | 17.59 MiB | `0fb6a562-3deb-43a0-9042-650f6c5fff66` |
| 250,000 | 完成 | 2.29 s | 27.38 MiB | `05234339-cbfb-47b1-b3ef-5546c253a7de` |
| 500,000 | 完成 | 4.46 s | 89.79 MiB | `c9e74b0b-efc8-416b-8b50-f32fc97eeac9` |
| 1,000,000 | 完成 | 7.91 s | 146.91 MiB | `aa10b268-7ea1-423d-bb37-5783549504dc` |

每个 run 的 manifest、case 输出和日志在 `tests/reports/summary/runs/<Run ID>/`。四次结果均为 valid、passed、not recorded。该用例观察初始化完成和 Worker 最终渲染完成，50 万点旧的流无法完整结束现象本次未复现。它并未独立逐点核对画布或网络分块，也未覆盖热点、冷页、多设备和重复采样；JS 堆不包含 Worker/GPU/进程总内存。结果是此环境下的诊断记录，不是容量上限、性能基线或发布认证。
