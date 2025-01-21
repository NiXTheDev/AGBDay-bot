import { Bot, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { CommandGroup, commandNotFound, commands , type CommandsFlavor} from "@grammyjs/commands";
import { hydrate, type HydrateFlavor } from "@grammyjs/hydrate";
import { Database } from 'bun:sqlite';
import { FileAdapter } from "@grammyjs/storage-file";
import { type ChatMember } from "grammy/types";
import { chatMembers, type ChatMembersFlavor } from "@grammyjs/chat-members";
import 'dotenv/config';


type BotContext = HydrateFlavor<Context & CommandsFlavor & ChatMembersFlavor>;
const token = process.env.BOT_TOKEN as string;

const bot = new Bot<BotContext>(token, {client: {apiRoot: 'https://nix.mercusysddns.com/tdlib'}});

const db = new Database(process.env.DATABASE_FILE, { create: true });
const memberStore = new FileAdapter<ChatMember>();

console.log('init db');
db.query('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, first TEXT, last TEXT, full GENERATED ALWAYS AS (first || " " || last) VIRTUAL, username TEXT)').run();
console.log('done');

bot.api.config.use(autoRetry({maxRetryAttempts: 5, maxDelaySeconds: 1800}));
bot.use(commands());
bot.use(hydrate());
bot.use(chatMembers(memberStore, {enableAggressiveStorage: true}));

const BotCommands = new CommandGroup<BotContext>({ignoreCase: true, targetedCommands: 'optional', matchOnlyAtStart: true});

BotCommands.command('return_user', 'Вернуть пользователя в группу').addToScope({type: 'all_chat_administrators'}, async (ctx) => {returnUser(ctx);});

BotCommands.setCommands(bot);
bot.use(BotCommands);
bot.filter(commandNotFound(BotCommands)).use(async (ctx) => {
  if (ctx.commandSuggestion) {
    console.log(`Received unrecognized command: ${ctx.message!.text}\nLuckly, found a similar command: ${ctx.commandSuggestion}`);
    await ctx.reply(
      `Команда не существует или не поддерживается\nВозможно, вы имелли ввиду: ${ctx.commandSuggestion}?`,
    );
    return;
  }

  // Nothing seems to come close to what the user typed
  console.log(`Received unrecognized command: ${ctx.message!.text}\nUnfortunately, no suggestion could be made`);
  await ctx.reply("Команда не существует или не поддерживается");
  return;
});

bot.on('chat_member', async (ctx) => {
  console.log(ctx.myChatMember);
})

bot.on(['msg', 'chat_member', ':file', 'edit'], async (ctx) => {console.log(ctx)})

bot.catch((err) => {console.log(err)});

bot.start({timeout: 900, allowed_updates: ['message', 'chat_member', 'edited_message', 'message_reaction', 'my_chat_member']});

async function returnUser(ctx: BotContext) {
  let userid: number = 0;
  const text: string | number | undefined = ctx.msg!.text!.split(' ')[1];
  if (text === undefined) {
    ctx.reply('Пожалуйста укажите пользователя для возвращения')
  } else if (text.match(/^[0-9]+$/)) {
    userid = text as unknown as number;
    ctx.api.unbanChatMember(ctx.chat!.id, userid);
  } else if (text.match(/^@[A-Za-z0-9_]{5,}$/)) {
    userid = db.query('SELECT id FROM users WHERE username = $username').get({username: text}) as number;
    
  }
}