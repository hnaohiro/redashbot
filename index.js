"use strict";

const Botkit = require("botkit");
const tempfile = require("tempfile");
const fs = require("fs");
const request = require("request");
const puppeteer = require("puppeteer");

// This configuration can gets overwritten when process.env.SLACK_MESSAGE_EVENTS is given.
const DEFAULT_SLACK_MESSAGE_EVENTS = "direct_message,direct_mention,mention";

if (!process.env.SLACK_BOT_TOKEN) {
  console.error("Error: Specify SLACK_BOT_TOKEN in environment values");
  process.exit(1);
}
if (!((process.env.REDASH_HOST && process.env.REDASH_API_KEY) || (process.env.REDASH_HOSTS_AND_API_KEYS))) {
  console.error("Error: Specify REDASH_HOST and REDASH_API_KEY in environment values");
  console.error("Or you can set multiple Re:dash configs by specifying like below");
  console.error("REDASH_HOSTS_AND_API_KEYS=\"http://redash1.example.com;TOKEN1,http://redash2.example.com;TOKEN2\"");
  process.exit(1);
}

const parseApiKeysPerHost = () => {
  if (process.env.REDASH_HOST) {
    if (process.env.REDASH_HOST_ALIAS) {
      return {[process.env.REDASH_HOST]: {"alias": process.env.REDASH_HOST_ALIAS, "key": process.env.REDASH_API_KEY}};
    } else {
      return {[process.env.REDASH_HOST]: {"alias": process.env.REDASH_HOST, "key": process.env.REDASH_API_KEY}};
    }
  } else {
    return process.env.REDASH_HOSTS_AND_API_KEYS.split(",").reduce((m, host_and_key) => {
      var [host, alias, key] = host_and_key.split(";");
      if (!key) {
        key = alias;
        alias = host;
      }
      m[host] = {"alias": alias, "key": key};
      return m;
    }, {});
  }
};

const redashApiKeysPerHost = parseApiKeysPerHost();
const slackBotToken = process.env.SLACK_BOT_TOKEN;
const slackMessageEvents = process.env.SLACK_MESSAGE_EVENTS || DEFAULT_SLACK_MESSAGE_EVENTS;

const controller = Botkit.slackbot({
  debug: !!process.env.DEBUG,
  retry: Infinity //https://botkit.ai/docs/readme-slack.html#botkitslackbot
});

controller.spawn({
  token: slackBotToken
}).startRTM(function (err) {
  if (err) {
    throw new Error(err);
  }
});

const takeSnapshot = async (url, outputFile) => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600 });
  await page.goto(url);
  await page.waitFor(3000);
  await page.screenshot({path: outputFile});
  await browser.close();
};

Object.keys(redashApiKeysPerHost).forEach((redashHost) => {
  const redashHostAlias = redashApiKeysPerHost[redashHost]["alias"];
  const redashApiKey    = redashApiKeysPerHost[redashHost]["key"];

  controller.hears(`${redashHost}/queries/([0-9]+)#([0-9]+)`, slackMessageEvents, (bot, message) => {
    const originalUrl = message.match[0];
    const queryId = message.match[1];
    const visualizationId =  message.match[2];
    const queryUrl = `${redashHostAlias}/queries/${queryId}#${visualizationId}`;
    const embedUrl = `${redashHostAlias}/embed/query/${queryId}/visualization/${visualizationId}?api_key=${redashApiKey}`;

    bot.botkit.log(queryUrl);
    bot.botkit.log(embedUrl);

    const outputFile = tempfile(".png");

    takeSnapshot(embedUrl, outputFile).then(() => {
      bot.botkit.log.debug(outputFile);
      bot.botkit.log.debug(Object.keys(message));
      bot.botkit.log(message.user + ":" + message.type + ":" + message.channel + ":" + message.text);
  
      const options = {
        token: slackBotToken,
        filename: `query-${queryId}-visualization-${visualizationId}.png`,
        file: fs.createReadStream(outputFile),
        channels: message.channel
      };
      request.post({ url: "https://api.slack.com/api/files.upload", formData: options }, (err, resp, body) => {
      if (err) {
          const msg = `Something wrong happend in file upload : ${err}`;
          bot.reply(message, msg);
          bot.botkit.log.error(msg);
        } else if (resp.statusCode == 200) {
          bot.botkit.log("ok");
        } else {
          const msg = `Something wrong happend in file upload : status code=${resp.statusCode}`;
          bot.reply(message, msg);
          bot.botkit.log.error(msg);
        }
      });
    });
  });
});
