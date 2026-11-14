# Aevia 入口与房间管理设计规则

## 范围与基调

此规则适用于首页、邀请页和共用的账号与房间管理弹窗。白板本身沿用既有设计。
采用现代极简的工作台布局：以房间列表和加入操作为中心，不设置营销展示区、虚构数据或装饰性插画。

## 色彩与字体

使用 `tokens.css` 的浅色中性背景、深色文字、低对比边框和靛紫操作色。正文和标题采用现有系统字体栈；房间号使用清晰、稳定的数字字形。色彩主要用于主要操作、选中状态和危险操作。

## 布局与交互

- 登录后：顶部品牌与账号，主体房间列表和独立的加入/创建面板，避免重复导航。
- 游客：只展示加入房间所需内容和登录入口，不显示无状态的房间工作台。
- 窄屏：收起侧栏，操作面板和列表纵向排列，不隐藏核心操作。
- 控件：统一圆角、边框、焦点环和加载/禁用状态；开关和分段按钮表达设置。
- 弹窗：使用应用内对话框，危险操作说明具体后果并要求确认；支持键盘焦点和关闭。
- 动效：只保留有意义的轻量状态过渡，尊重系统减少动态效果设置。

## Exports

### tokens.css

项目根目录的 `tokens.css` 是 CSS 变量来源；`--entry-*` 是入口专用名称，语义化变量提供可移植别名。

### Tailwind v4

```css
@theme {
  --color-paper: oklch(97.4% 0.006 270);
  --color-ink: oklch(25% 0.021 270);
  --color-accent: oklch(49% 0.15 275);
  --font-body: "Segoe UI", "Microsoft YaHei UI", sans-serif;
  --spacing-md: 1.5rem;
}
```

### DTCG tokens.json

```json
{
  "color": {
    "paper": { "$value": "oklch(97.4% 0.006 270)", "$type": "color" },
    "ink": { "$value": "oklch(25% 0.021 270)", "$type": "color" },
    "accent": { "$value": "oklch(49% 0.15 275)", "$type": "color" }
  },
  "space": { "md": { "$value": "1.5rem", "$type": "dimension" } }
}
```

### shadcn/ui CSS variables

```css
:root {
  --background: 97.4% 0.006 270;
  --foreground: 25% 0.021 270;
  --primary: 49% 0.15 275;
  --primary-foreground: 100% 0 0;
  --border: 90.7% 0.009 270;
  --ring: 49% 0.15 275;
  --radius: 8px;
}
```
