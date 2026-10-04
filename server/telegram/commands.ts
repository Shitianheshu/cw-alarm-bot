import config from "@Server/config";
import { Telegraf } from "telegraf";
import { getScrapingStatus, startScraping, stopScraping } from "@Server/controller/scrapeController";
import { saveUserTelegramId } from "@Server/controller/authController";
import { publishMarketReport, scanRecentJobs, startAnalysisAlarm, startMarketWatch, stopAnalysisAlarm, stopMarketWatch } from "@Server/controller/marketAnalysisController";

const commands: {
  command: string;
  description: string;
}[] = [
    { command: "start", description: "Start the bot" },
    { command: "start_scraping", description: "Start automatic scraping process !!!" },
    { command: "stop_scraping", description: "Stop automatic scraping process !!!" },
    { command: "request_access", description: "Request access to receive job notifications" },
    { command: "market_scan", description: "Count jobs posted in the last 24h and notify" },
    { command: "market_watch", description: "Watch new jobs and sample bids at 1-30 min" },
    { command: "market_stop", description: "Stop the market watch poll" },
    { command: "market_report", description: "Send the current market report" },
    { command: "market_alarm", description: "Push analysis every 1, 2, 5… minutes" },
    { command: "market_alarm_stop", description: "Stop the automatic analysis alarm" },
  ];

const setup_commands = async (bot: Telegraf) => {
  await bot.telegram.setMyCommands(commands);

  const adminCheck = async (ctx: any) => {
    const userId = ctx.update.message.from.id;
    if (config.ADMIN_ID !== userId.toString()) {
      await ctx.reply(`🚫 This command is for admin only.`);
      return false;
    }
    return true;
  }

  bot.start(async (ctx) => {
    try {
      console.log(ctx.chat.id, 'chatid')
      await ctx.reply(
        `👋 Welcome to the *CrowedWorks Job Bidder Bot* \n 
        please select one of the following options.\n\n 
        If you need assistance, please contact @wyvern280: 🐉`);
    } catch (error) {
      console.error("Error in /start:", error);
      await ctx.reply("An error occurred. Please try again later.");
    }
  });

  bot.command("start_scraping", async (ctx) => {
    let isAdmin = await adminCheck(ctx);
    if (!isAdmin) return;

    try {
      const scrapingStatus = getScrapingStatus();
      if (scrapingStatus) return await ctx.reply("Scraping is currently running.");
      const result = startScraping();
      await ctx.reply(result.message);
    } catch (error) {
      console.error("Error on start scraping:", error);
      await ctx.reply("An error occurred. Please try again later.");
    }
  });

  // setTimeout(() => {
  //   startScraping();  
  // }, 10000);

  bot.command("stop_scraping", async (ctx) => {
    let isAdmin = await adminCheck(ctx);
    if (!isAdmin) return;

    try {
      const result = stopScraping();
      await ctx.reply(result.message);
    } catch (error) {
      console.error("Error on stop scraping:", error);
      await ctx.reply("An error occurred. Please try again later.");
    }
  });

  bot.command("market_scan", async (ctx) => {
    const isAdmin = await adminCheck(ctx);
    if (!isAdmin) return;
    try {
      const result = scanRecentJobs({ notify: true });
      await ctx.reply(result.message);
    } catch (error) {
      console.error("Error on market scan:", error);
      await ctx.reply("An error occurred. Please try again later.");
    }
  });

  bot.command("market_watch", async (ctx) => {
    const isAdmin = await adminCheck(ctx);
    if (!isAdmin) return;
    try {
      const result = startMarketWatch();
      await ctx.reply(result.message);
    } catch (error) {
      console.error("Error on market watch:", error);
      await ctx.reply("An error occurred. Please try again later.");
    }
  });

  bot.command("market_stop", async (ctx) => {
    const isAdmin = await adminCheck(ctx);
    if (!isAdmin) return;
    try {
      const result = stopMarketWatch();
      await ctx.reply(result.message);
    } catch (error) {
      console.error("Error on market stop:", error);
      await ctx.reply("An error occurred. Please try again later.");
    }
  });

  bot.command("market_report", async (ctx) => {
    const isAdmin = await adminCheck(ctx);
    if (!isAdmin) return;
    try {
      await ctx.reply("レポートを集計しています…");
      await publishMarketReport();
    } catch (error) {
      console.error("Error on market report:", error);
      await ctx.reply("An error occurred. Please try again later.");
    }
  });

  bot.command("market_alarm", async (ctx) => {
    const isAdmin = await adminCheck(ctx);
    if (!isAdmin) return;
    try {
      const result = startAnalysisAlarm();
      await ctx.reply(result.message);
    } catch (error) {
      console.error("Error on market alarm:", error);
      await ctx.reply("An error occurred. Please try again later.");
    }
  });

  bot.command("market_alarm_stop", async (ctx) => {
    const isAdmin = await adminCheck(ctx);
    if (!isAdmin) return;
    try {
      const result = stopAnalysisAlarm();
      await ctx.reply(result.message);
    } catch (error) {
      console.error("Error on market alarm stop:", error);
      await ctx.reply("An error occurred. Please try again later.");
    }
  });

  bot.command("request_access", async (ctx) => {
    try {
      const userId = ctx.update.message.from.id;

      const result = await saveUserTelegramId(userId);
      await ctx.reply(result.message);
    } catch (error) {
      console.error("Error in /request_access:", error);
      await ctx.reply("❌ An error occurred while processing your request. Please try again later.");
    }
  });


};

export default setup_commands;
