import { chromium, type Page, type BrowserContext } from 'playwright';
import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';

export const CONFIG = {
    API_URL: 'http://192.168.10.102:4646',
    WS_URL: 'ws://192.168.10.102:4646',
    FRONTEND_URL: 'http://localhost:5173',
    ROOM_PASSWORD: '',
    COLORS: [
        "#000000", "#ef4444", "#f97316", "#fbbf24",
        "#84cc16", "#22c55e", "#06b6d4", "#3b82f6",
        "#6366f1", "#a855f7", "#ec4899", "#ffffff",
    ],
};

export const request = async (url: string, body: any, retries = 3): Promise<any> => {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.ok) {
                return await res.json();
            }
        } catch (e) {
            if (i === retries - 1) throw e;
        }
        await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
    }
    return null;
};

export const joinRoom = async (roomId: string, userName: string) => {
    const data = await request(`${CONFIG.API_URL}/join-room`, { roomId, userName, password: CONFIG.ROOM_PASSWORD });
    if (!data) {
        throw new Error(`[API Error] joinRoom fetch failed completely for ${userName}`);
    }
    if (data.code !== 200) {
        console.error(`[API Error] joinRoom failed for ${userName}:`, data);
        return null;
    }
    return { token: data.data.token, userId: data.data.userId };
};

export const createRoom = async (roomId: string, roomName: string = 'Test Room') => {
    const data = await request(`${CONFIG.API_URL}/create-room`, { roomId, roomName, password: CONFIG.ROOM_PASSWORD });
    if (!data) {
        console.error(`[API Error] createRoom fetch failed completely for ${roomId}`);
        return;
    }
    if (data.code !== 200) {
        console.error(`[API Error] createRoom failed for ${roomId}:`, data);
    }
};

export class WebSocketInjector {
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

            this.ws.on('open', () => { });

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

    // 极速向套接字压入指定数量的点
    async injectPoints(targetPoints: number, pointsPerStroke: number = 200) {
        if (!this.ws || !this.isReady) throw new Error('Injector 未就绪');

        let sentPoints = 0;
        let strokes = Math.ceil(targetPoints / pointsPerStroke);

        for (let s = 0; s < strokes; s++) {
            const cmdId = uuidv4();
            const color = CONFIG.COLORS[Math.floor(Math.random() * CONFIG.COLORS.length)];
            const size = Math.floor(Math.random() * 8) + 2;

            let x = 100 + Math.random() * 1000;
            let y = 100 + Math.random() * 600;

            const currentPoints: any[] = [];
            let steps = Math.min(pointsPerStroke, targetPoints - sentPoints);

            for (let i = 0; i < steps; i++) {
                x += (Math.random() - 0.5) * 15;
                y += (Math.random() - 0.5) * 15;
                const p = 0.2 + Math.random() * 0.8;

                const p0 = {
                    x: Math.round((x / 1280) * 100000) / 100000,
                    y: Math.round((y / 720) * 100000) / 100000,
                    p: Math.round(p * 100000) / 100000
                };

                currentPoints.push(p0);
                this.lamport++;
                sentPoints++;

                if (i === 0) {
                    const cmdObj = {
                        id: cmdId, type: 'path', points: [...currentPoints],
                        tool: 'pen', color: color, size: size,
                        timestamp: Date.now(), userId: this.userId, roomId: this.roomId,
                        pageId: 0, isDeleted: false, lamport: this.lamport,
                        box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }
                    };
                    const payload = { type: 'cmd-start', data: { id: cmdId, cmd: cmdObj, lamport: this.lamport } };
                    this.ws.send(JSON.stringify(payload));
                }

                if (i === steps - 1) {
                    const cmdObj = {
                        id: cmdId, type: 'path', points: [...currentPoints],
                        tool: 'pen', color: color, size: size,
                        timestamp: Date.now(), userId: this.userId, roomId: this.roomId,
                        pageId: 0, isDeleted: false, lamport: this.lamport,
                        box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }
                    };
                    const payload = { type: 'cmd-stop', data: { cmdId: cmdId, cmd: cmdObj, lamport: this.lamport, points: [...currentPoints], box: cmdObj.box } };
                    this.ws.send(JSON.stringify(payload));
                }

                if (i % 50 === 0) await new Promise(r => setTimeout(r, 1));
            }
            await new Promise(r => setTimeout(r, 5));
        }
        return sentPoints;
    }

    // 持续高频逼真画笔模拟 (用于长时压测)
    // 模拟真实的 60Hz 人类绘图手速
    async injectRealtimeStrokes(fps: number = 60, durationMs: number = 10000, maxPointsPerStroke: number = 200) {
        if (!this.ws || !this.isReady) throw new Error('Injector 未就绪');

        let isDrawing = false;
        let pointsInCurrentStroke = 0;
        let currentCmdId = '';
        let currentPoints: any[] = [];
        let strokeColor = '';
        let strokeSize = 3;
        let sentPoints = 0;

        let posX = 100 + Math.random() * 1000;
        let posY = 100 + Math.random() * 600;

        const intervalMs = 1000 / fps;
        const totalFrames = durationMs / intervalMs;

        for (let frameNum = 0; frameNum < totalFrames; frameNum++) {
            // 定期起笔和收笔
            if (!isDrawing) {
                isDrawing = true;
                pointsInCurrentStroke = 0;
                currentCmdId = uuidv4();
                strokeColor = CONFIG.COLORS[Math.floor(Math.random() * CONFIG.COLORS.length)];
                strokeSize = Math.floor(Math.random() * 8) + 2;
                currentPoints = [];
                posX = 100 + Math.random() * 1000;
                posY = 100 + Math.random() * 600;

                const p0 = {
                    x: Math.round((posX / 1280) * 100000) / 100000,
                    y: Math.round((posY / 720) * 100000) / 100000,
                    p: Math.round((0.2 + Math.random() * 0.8) * 100000) / 100000
                };
                currentPoints.push(p0);
                this.lamport++;
                sentPoints++;

                const startObj = {
                    id: currentCmdId, type: 'path', points: [...currentPoints],
                    tool: 'pen', color: strokeColor, size: strokeSize,
                    timestamp: Date.now(), userId: this.userId, roomId: this.roomId,
                    pageId: 0, isDeleted: false, lamport: this.lamport,
                    box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }
                };
                this.ws.send(JSON.stringify({ type: 'cmd-start', data: { id: currentCmdId, cmd: startObj, lamport: this.lamport } }));
            } else {
                pointsInCurrentStroke++;
                posX += (Math.random() - 0.5) * 15;
                posY += (Math.random() - 0.5) * 15;

                const pNext = {
                    x: Math.round((posX / 1280) * 100000) / 100000,
                    y: Math.round((posY / 720) * 100000) / 100000,
                    p: Math.round((0.2 + Math.random() * 0.8) * 100000) / 100000
                };
                currentPoints.push(pNext);
                sentPoints++;

                // 发送防抖积攒点（模拟普通 update）
                this.lamport++;
                const updateObj = {
                    id: currentCmdId, type: 'path',
                    tool: 'pen', color: strokeColor, size: strokeSize,
                    timestamp: Date.now(), userId: this.userId, roomId: this.roomId,
                    pageId: 0, isDeleted: false, lamport: this.lamport,
                    box: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }
                };
                // 每收集够几个点才发一次 update 逼近真实防抖
                if (pointsInCurrentStroke % 3 === 0) {
                    this.ws.send(JSON.stringify({ type: 'cmd-update', data: { cmdId: currentCmdId, cmd: updateObj, lamport: this.lamport, points: [pNext] } }));
                }

                // 收笔
                if (pointsInCurrentStroke >= maxPointsPerStroke || frameNum === totalFrames - 1) {
                    isDrawing = false;
                    this.lamport++;
                    updateObj.lamport = this.lamport;
                    this.ws.send(JSON.stringify({ type: 'cmd-stop', data: { cmdId: currentCmdId, cmd: updateObj, lamport: this.lamport, points: currentPoints, box: updateObj.box } }));
                }
            }
            // 精确等待一帧的时间
            await new Promise(r => setTimeout(r, intervalMs));
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
