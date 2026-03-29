import chalk from "chalk";

const timestamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

export const log = {
  info:    (msg) => console.log(`${chalk.gray(timestamp())} ${chalk.cyan("ℹ")}  ${msg}`),
  success: (msg) => console.log(`${chalk.gray(timestamp())} ${chalk.green("✓")}  ${msg}`),
  warn:    (msg) => console.log(`${chalk.gray(timestamp())} ${chalk.yellow("⚠")}  ${msg}`),
  error:   (msg) => console.log(`${chalk.gray(timestamp())} ${chalk.red("✗")}  ${msg}`),
  send:    (msg) => console.log(`${chalk.gray(timestamp())} ${chalk.blue("✉")}  ${msg}`),
  reply:   (msg) => console.log(`${chalk.gray(timestamp())} ${chalk.magenta("📬")} ${msg}`),
  cron:    (msg) => console.log(`${chalk.gray(timestamp())} ${chalk.yellow("⏰")} ${msg}`),
};
