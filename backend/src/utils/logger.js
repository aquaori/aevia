const chalk = require("chalk");
const boxen = require("boxen");
const gradient = require("gradient-string");

const themes = {
  primary: "#00d2ff",
  secondary: "#9d50bb",
  success: "#00ff87",
  error: "#ff0061",
  warning: "#f09819",
  info: "#3a7bd5"
};

class Logger {
  static getTime() {
    return chalk.gray(`[${new Date().toLocaleTimeString()}]`);
  }

  static welcome() {
    const title = gradient(["#00d2ff", "#9d50bb", "#ff0061"])(" COLLABORATIVE WHITEBOARD ENGINE ");
    const box = boxen(
      `${chalk.bold(title)}\n\n${chalk.dim("Build amazing things together in real-time.")}\n\n${chalk.blue("→ Documentation:")} ${chalk.underline("https://github.com/your-repo/whiteboard")}`,
      {
        padding: 1,
        margin: 1,
        borderStyle: "round",
        borderColor: themes.secondary,
        float: "center",
        textAlignment: "center"
      }
    );
    console.log(box);
  }

  static serverInfo(port, host, localIp) {
    const label = (text) => chalk.bold.white(text.padEnd(10));
    const value = (text) => chalk.cyan(text);
    
    const content = [
      `${label("STATUS")} ${chalk.bgGreen.black(" ACTIVE ")}`,
      `${label("PORT")} ${value(port)}`,
      `${label("LOCAL")} ${value(`http://${host}:${port}`)}`,
      `${label("NETWORK")} ${value(`http://${localIp}:${port}`)}`,
      `${label("VERSION")} ${chalk.gray("v1.0.0")}`
    ].join("\n");

    console.log(boxen(content, {
      padding: 1,
      borderColor: themes.info,
      title: "📡 SERVER INFRASTRUCTURE",
      titleAlignment: "left",
      borderStyle: "bold"
    }));
  }

  static info(msg, ...args) {
    console.log(`${this.getTime()} ${chalk.blue("ℹ")} ${chalk.blue(msg)}`, ...args);
  }

  static success(msg, ...args) {
    console.log(`${this.getTime()} ${chalk.green("✔")} ${chalk.green(msg)}`, ...args);
  }

  static warn(msg, ...args) {
    console.log(`${this.getTime()} ${chalk.yellow("⚠")} ${chalk.yellow(msg)}`, ...args);
  }

  static error(msg, ...args) {
    console.log(`${this.getTime()} ${chalk.red("✖")} ${chalk.red(msg)}`, ...args);
  }

  /**
   * 细化后的 WebSocket 事件输出
   */
  static wsEvent(action, userName, userId, roomId, detail = "") {
    const time = this.getTime();
    const userDisplay = `${chalk.bold.magenta(userName)}${chalk.dim(`(${userId.slice(0, 8)})`)}`;
    const roomDisplay = chalk.italic.cyan(roomId);

    switch (action) {
      case "joined":
        console.log(`${time} ${chalk.green("➡️ ")} ${userDisplay} joined ${roomDisplay} ${chalk.gray(detail)}`);
        break;
      case "left":
        console.log(`${time} ${chalk.red("⬅️ ")} ${userDisplay} left ${roomDisplay}`);
        break;
      case "undo":
        console.log(`${time} ${chalk.yellow("↩️ ")} ${chalk.dim(`[${roomDisplay}]`)} ${userDisplay} undo ${detail}`);
        break;
      case "redo":
        console.log(`${time} ${chalk.blue("↪️ ")} ${chalk.dim(`[${roomDisplay}]`)} ${userDisplay} redo ${detail}`);
        break;
      default:
        console.log(`${time} 🔔 ${chalk.dim(`[${roomDisplay}]`)} ${userDisplay} ${action} ${detail}`);
    }
  }

  static cmd(type, cmdId) {
    // 过滤 cmd-update 日志防止刷屏
    if (type === "cmd-update") return;
    
    const icon = type === "cmd-start" ? "🎨" : "📦";
    console.log(`${this.getTime()} ${icon} ${chalk.dim("Received:")} ${chalk.yellow(type)} | ${chalk.gray(cmdId)}`);
  }
}

module.exports = Logger;
