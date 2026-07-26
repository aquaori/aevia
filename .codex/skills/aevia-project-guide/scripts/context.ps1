param(
    [string]$Topic = "overview"
)

$topics = @{
    overview = @{
        references = @("references/overview.md")
        files = @("package.json", "README.md", "scripts/dev.mjs", ".codex/AGENTS.md")
        searches = @("rg --files", "rg `"workspace|scripts|dev`" package.json apps packages")
        verify = @("cmd /c npm run build --workspace @collaborative-whiteboard/frontend")
    }
    frontend = @{
        references = @("references/frontend.md", "references/protocol.md")
        files = @(
            "apps/frontend/src/views/RoomView.vue",
            "apps/frontend/src/store/commandStore.ts",
            "apps/frontend/src/service/localCommandService.ts",
            "apps/frontend/src/service/collabCommandHandlers.ts"
        )
        searches = @("rg `"function|const|export`" apps/frontend/src/service apps/frontend/src/controllers")
        verify = @("cmd /c npm run build --workspace @collaborative-whiteboard/frontend")
    }
    backend = @{
        references = @("references/backend.md", "references/protocol.md")
        files = @(


            "apps/backend/internal/room/events.go"
        )
        searches = @("rg `"cmd-|init-|page-change|join-room`" apps/backend/internal")
        verify = @("cmd /c npm run test:integration")
    }
    protocol = @{
        references = @("references/protocol.md")
        files = @(
            "packages/shared/src/types/collab.ts",
            "packages/shared/src/protocol/collabProtocol.ts",
            "apps/frontend/src/service/realtimeBinary.ts",
            "apps/backend/internal/protocol/realtime.go"
        )
        searches = @("rg `"Command|FlatPoint|cmd-update|mouseMove`" apps packages")
        verify = @("cmd /c npm run test:unit", "cmd /c npm run test:integration")
    }
    benchmark = @{
        references = @("references/testing-benchmarks.md")
        files = @(
            "apps/frontend/tests/e2e/external/runner.ts",
            "apps/frontend/tests/e2e/external/config.ts",
            "apps/frontend/tests/e2e/external/suites.ts",
            "apps/frontend/tests/e2e/external/reporter.ts",
            "tests/report/aggregate.ts"
        )
        searches = @("rg `"performance-external|correctness-smoke|baseline|report-dir`" apps/frontend/tests/e2e/external tests/report")
        verify = @("cmd /c npm run test:report")
    }
    tests = @{
        references = @("references/testing-benchmarks.md")
        files = @("vitest.config.ts", "tests/report/aggregate.ts", "apps/frontend/tests/e2e/external/runner.ts")
        searches = @("rg `"projects|testMatch|reporter|outputFile`" vitest.config.ts package.json apps/frontend/package.json")
        verify = @("cmd /c npm run test:unit")
    }
    rendering = @{
        references = @("references/frontend.md", "references/protocol.md")
        files = @(
            "apps/frontend/src/service/renderWorkerBridge.ts",
            "apps/frontend/src/workers/canvasWorker.ts",
            "apps/frontend/src/service/strokeRasterizer.ts",
            "apps/frontend/src/service/dirtyRenderQueue.ts",
            "apps/frontend/src/utils/dirtyRedraw.ts"
        )
        searches = @("rg `"dirty|render|OffscreenCanvas|clip|FlatPoint`" apps/frontend/src")
        verify = @("cmd /c npm run build --workspace @collaborative-whiteboard/frontend", "cmd /c npm run test:browser")
    }
    websocket = @{
        references = @("references/backend.md", "references/frontend.md", "references/protocol.md")
        files = @(
            "apps/frontend/src/service/roomCollabTransport.ts",
            "apps/frontend/src/service/collabMessageDispatcher.ts",
            "apps/backend/internal/room/events.go"
        )
        searches = @("rg `"WebSocket|Sec-WebSocket-Protocol|cmd-update|mouseMove`" apps")
        verify = @("cmd /c npm run test:e2e:smoke")
    }
    page = @{
        references = @("references/frontend.md", "references/backend.md", "references/protocol.md")
        files = @(
            "apps/frontend/src/service/roomPageService.ts",
            "apps/frontend/src/store/commandStore.ts",
            "apps/backend/internal/room/events.go"
        )
        searches = @("rg `"page-change|loadedPageIds|PAGE_CACHE_RADIUS|pageId`" apps packages")
        verify = @("cmd /c npm run test:browser", "cmd /c npm run test:e2e:smoke")
    }
    auth = @{
        references = @("references/backend.md", "references/frontend.md")
        files = @(


            "apps/frontend/src/service/sessionApi.ts",
            "apps/frontend/src/store/userStore.ts"
        )
        searches = @("rg `"join-room|renew-room-session|Authorization|sessionToken|JWT`" apps")
        verify = @("cmd /c npm run test:integration")
    }
    skill = @{
        references = @("references/update-skill.md", "references/index.md")
        files = @(
            ".codex/skills/aevia-project-guide/SKILL.md",
            ".codex/skills/aevia-project-guide/scripts/context.ps1",
            ".codex/AGENTS.md"
        )
        searches = @("rg `"aevia-project-guide|Aevia Project Guide`" .codex")
        verify = @("python C:\Users\ASUS\.codex\skills\.system\skill-creator\scripts\quick_validate.py .codex\skills\aevia-project-guide")
    }
}

$key = $Topic.ToLowerInvariant()
if (-not $topics.ContainsKey($key)) {
    $key = "overview"
}

$result = [ordered]@{
    topic = $key
    references = $topics[$key].references
    files = $topics[$key].files
    searches = $topics[$key].searches
    verify = $topics[$key].verify
}

$result | ConvertTo-Json -Depth 5
