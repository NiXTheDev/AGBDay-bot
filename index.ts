import { Bot, type Context, session } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { CommandGroup, commandNotFound, commands , type CommandsFlavor} from "@grammyjs/commands";
import type { Message, SharedUser } from "grammy/types";
import { hydrate, type HydrateFlavor } from "@grammyjs/hydrate";
import {
  type Conversation,
  type ConversationFlavor,
  conversations,
  createConversation,
} from "@grammyjs/conversations";
import { Database } from 'bun:sqlite';
const schedule = require('node-schedule');
import 'dotenv/config';


type BotContext = HydrateFlavor<Context & CommandsFlavor & ConversationFlavor>;
type BotConversation = Conversation<BotContext>;
// type DBUser = {id: number, username: string | undefined, first: string, last: string | undefined, full: string} & Object;
const token = process.env.BOT_TOKEN as string;

class DBUser extends Object {
  id!: number;
  username?: string;
  first!: string;
  last?: string;
  full?: string = this.first + ' ' + this.last;
  birthday?: Date;
}

class Birthday extends Object {
  user_id!: number;
  chat_id!: number;
  date?: Date;
}

class BannedUser extends Object {
  user_id!: number;
  chat_id!: number;
}

const bot = new Bot<BotContext>(token, {client: {apiRoot: 'https://nix.mercusysddns.com/tdlib'}});

const db = new Database('./config.db', { create: true, strict: true });

console.log('init db');

db.query('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, first TEXT, last TEXT, full GENERATED ALWAYS AS (first || " " || last) VIRTUAL, username TEXT, birthday INTEGER)').run();
db.query('CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY, title TEXT, username TEXT, type TEXT)').run();
db.query('CREATE TABLE IF NOT EXISTS birthdays (user_id INTEGER PRIMARY KEY REFERENCES users (id) ON UPDATE CASCADE, chat_id INTEGER REFERENCES chats (id) ON UPDATE CASCADE, date INTEGER)').run();
db.query('CREATE TABLE IF NOT EXISTS chat_users (chat_id INTEGER REFERENCES chats (id) ON UPDATE CASCADE, user_id INTEGER REFERENCES users (id) ON UPDATE CASCADE)').run();
db.query('CREATE TABLE IF NOT EXISTS banned_users (user_id INTEGER PRIMARY KEY REFERENCES users (id) ON UPDATE CASCADE, chat_id INTEGER REFERENCES chats (id) ON UPDATE CASCADE)').run();

console.log('done');
const getUserByUsername = db.prepare('SELECT * FROM users WHERE username = $username').as(DBUser);
const getUserById = db.prepare('SELECT * FROM users WHERE id = $id').as(DBUser);

bot.api.config.use(autoRetry({maxRetryAttempts: 5, maxDelaySeconds: 1800}));
bot.use(commands());
bot.use(hydrate());
bot.use(session({ initial: () => ({}) }));
bot.use(conversations());
bot.use(createConversation(addUser))

const BotCommands = new CommandGroup<BotContext>({ignoreCase: true, targetedCommands: 'optional', matchOnlyAtStart: true});

BotCommands.command('return_user', 'Вернуть пользователя в группу').addToScope({type: 'all_chat_administrators'}, async (ctx) => {returnUser(ctx)});
BotCommands.command('add', 'Добавить пользователей в БД').addToScope({type: 'all_chat_administrators'}, (ctx) => {ctx.api.sendMessage(ctx.chat.id, 'Эта команда работает только в Личных Сообщениях', {reply_markup: {inline_keyboard: [[{text: 'Открыть в ЛС', url: 'https://t.me/AGSoft_BirthayManagerBot?start=-4727560463'}]]}})}).addToScope({type: 'all_private_chats'}, async (ctx) => {ctx.conversation.enter('addUser')});
BotCommands.command('start', 'add для кнопок').addToScope({type: 'all_private_chats'}, async (ctx) => {ctx.conversation.enter('addUser')});
BotCommands.command('setBirthday', 'Установить свой день рождения').addToScope({type: 'all_private_chats'}, async (ctx) => {});

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
  console.log(`Received unrecognized command: ${ctx.message!.text}`, `No suggestion could be made, ignoring command...`);
  await ctx.reply("Команда не существует или не поддерживается");
  // checkUser(ctx);
  return;
});

bot.on('chat_member', async (ctx) => {
  console.log(`got chat member: ${ctx.chatMember}`);
  // checkUser(ctx);
});

bot.on([':migrate_from_chat_id', ':migrate_to_chat_id'], async (ctx) => {
  db.query('UPDATE chats SET id = $id WHERE id = $old_id').run({id: ctx.msg!.migrate_to_chat_id!.toString(), old_id: ctx.msg!.migrate_from_chat_id!.toString()});
});

// bot.on(['msg', 'edit'], async (ctx) => {
//   console.log(`got message: ${ctx.msg.text}`);
//   checkUser(ctx);
// });

bot.catch((err) => {console.log(err)});

bot.start({timeout: 900, allowed_updates: ['message', 'chat_member', 'edited_message', 'message_reaction', 'my_chat_member'], drop_pending_updates: true});

async function returnUser(ctx: BotContext) {
  let userid: number = 0;
  const text: string | number | undefined = ctx.msg!.text!.split(' ')[1];
  if (text === undefined) {
    ctx.reply('Пожалуйста укажите пользователя для возвращения');
  } else if (text.match(/^[0-9]+$/)) {
    userid = parseInt(text, 10);
    ctx.api.unbanChatMember(ctx.chat!.id, userid);
  } else if (text.match(/^@[A-Za-z0-9_]{5,}$/)) {
    const user = getUserByUsername.get({username: text});
    if (user) {
      userid = user.id;
      ctx.api.unbanChatMember(ctx.chat!.id, userid);
    } else {
      ctx.reply('Пользователь не найден, попробуйте использовать его id');
    }
  }
}


function checkUser(user: DBUser) {
  let userCheck = getUserById.get({id: user.id});
  if (!userCheck) {db.query('insert into users (id, username, first, last) values ($id, $username, $first, $last)').run({id: user.id, username: user.username as string, first: user.first as string, last: user.last as string}); return 'Added'}
  const diffKeys = Object.keys(user).filter(key => user[key as keyof DBUser] !== userCheck[key as keyof DBUser]);
  if (Object.keys(userCheck).filter(key => key !== 'id').every((key) => userCheck[key as keyof DBUser] === user[key as keyof DBUser])) {return 'Skipped'} else {
    const status = updateUserInDb(user, diffKeys);
    return status;
  }
}

/**
 * Updates a user in the database with the specified changes.
 * If `diffKeys` is not provided, all keys will be updated.
 *
 * @param {DBUser} user - The user object containing updated data.
 * @param {string[]} [diffKeys] - Optional array of keys to update. If not provided, all fields will be updated.
 */
function updateUserInDb(user: DBUser, diffKeys?: string[]) {
  try {
    const keysToUpdate = diffKeys ?? Object.keys(user) as string[];
    if (keysToUpdate.length > 0) {
      const setClause = keysToUpdate.map(key => `${key} = $${key}`).join(', ');
      const updateStmt = `UPDATE users SET ${setClause} WHERE id = $id`;
      const params = keysToUpdate.reduce((acc, key) => {
        acc[key] = user[key as keyof DBUser];
        return acc;
      }, { id: user.id } as Record<string, any>);

      db.prepare(updateStmt).run(params);
      return 'Updated'
  }
  } catch {
    return 'Failed'
  }
}

async function addUser(conversation: BotConversation, ctx: BotContext) {
  let status: Array<any> = [];
  let chat_id: number | undefined;
  const arg: number | undefined = ctx.message!.text!.split(' ')[1] as unknown as number;
  if (!arg) {
    ctx.api.sendMessage(ctx.chat!.id, 'Выберите чат', {
      reply_markup: {
        keyboard: [
          [
            {
              text: 'Выбрать чат',
              request_chat: {
                request_id: 1,
                chat_is_channel: false,
                user_administrator_rights: {
                  is_anonymous: false,
                  can_manage_chat: false,
                  can_delete_messages: false,
                  can_manage_video_chats: false,
                  can_restrict_members: true,
                  can_promote_members: false,
                  can_change_info: false,
                  can_invite_users: true,
                  can_post_stories: false,
                  can_edit_stories: false,
                  can_delete_stories: false
                },
                bot_administrator_rights: {
                  can_invite_users: true,
                  is_anonymous: false,
                  can_manage_chat: false,
                  can_delete_messages: false,
                  can_manage_video_chats: false,
                  can_restrict_members: true,
                  can_promote_members: false,
                  can_change_info: false,
                  can_post_stories: false,
                  can_edit_stories: false,
                  can_delete_stories: false,
                },
                bot_is_member: true,
                request_title: true,
                request_username: true,
              },
            },
          ],
        ],
        one_time_keyboard: true,
        resize_keyboard: true,
      },
    });
    chat_id = (await conversation.waitFor(':chat_shared')).message!.chat_shared.chat_id;
  } else {
  // if (arg) {
    chat_id = arg;
  }
  console.log(chat_id);
  ctx.api.sendMessage(ctx.chat!.id, 'Теперь выберите пользователя/телей которых добавите в этот чат', {
    reply_markup: {
      keyboard: [
        [
          {
            text: 'Выбрать пользователя/телей',
            request_users: {
              request_id: 1,
              user_is_bot: false,
              max_quantity: 10,
              request_name: true,
              request_username: true
            },
          },
        ],
      ],
      one_time_keyboard: true,
      resize_keyboard: true,
    },
  });
  const message = (await conversation.waitFor('message')).msg! as Message;
  let users: SharedUser[] = [];
  if ((Object.keys(message) as string[]).includes('users_shared')) {
    users = message.users_shared!.users as SharedUser[];
  } else
  if (message.text! === '/me') {
    users = [{user_id: message.from!.id, first_name: message.from!.first_name, last_name: message.from!.last_name, username: message.from!.username}];
  }
  console.log(users);
  ctx.reply(`Замечательно, сейчас добавлю этих пользователей в этот чат, если это не все пользователи которых вы хотели добавить, отправьте \`/add \\${chat_id}\` чтобы добавить больше\\!`, {parse_mode: 'MarkdownV2', reply_markup: { remove_keyboard: true }});
  users.forEach(async (user) => {
    console.log(`Adding ${user.user_id}...`);
    const userNew: DBUser = {
      id: user.user_id,
      username: user.username,
      first: user.first_name!,
      last: user.last_name
    }
    const identifier = user.username ? user.username : user.user_id.toString();
    console.log(identifier);
    console.log(checkUser(userNew) as string);
    status.push([identifier, checkUser(userNew) as string] as string[]);
  });
  console.log(status);
  ctx.api.sendMessage(ctx.chat!.id, `Добавлено пользователей:\n${status.map((user) => {return `\\- ${user[0]}: ${user[1]}`}).join('\n')}`, {parse_mode: 'MarkdownV2', reply_markup: { remove_keyboard: true }});
}

async function checkBirthdays() {
  const now = new Date();
  const twoWeeksFromNow = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const users = db.query('SELECT * FROM users').as(DBUser).all() as DBUser[];
  const birthdays = db.query('SELECT * FROM birthdays').as(Birthday).all() as Birthday[];

  console.log(now);
  console.log(twoWeeksFromNow);
  console.log(users);
  console.log(birthdays);

  const birthdaysInTwoWeeks = db.query('SELECT * FROM birthdays WHERE date <= $twoWeeksFromNow').as(Birthday).all({twoWeeksFromNow: twoWeeksFromNow.getTime()}) as Birthday[];
  if (birthdaysInTwoWeeks.length > 0) {
    console.log(`Users with birthdays coming in 2 or less weeks:`);
    birthdaysInTwoWeeks.forEach(birthday => console.log(`- ${birthday.user_id}: ${birthday.date}`));
    //! Untested logic ahead, scary stuff(DB 'INSERT', 'UPDATE' and etc) are commented out for safety
    console.log((birthdaysInTwoWeeks.map(birthday => birthday.user_id)).toString());
    const users_chats = db.query('SELECT * FROM chat_users WHERE user_id IN ($userIds)').as(BannedUser).all({userIds: (birthdaysInTwoWeeks.map(birthday => birthday.user_id)).toString()}) as BannedUser[];
    console.log(users_chats);
  }
}

// Schedule the function to run at a specific time
schedule.scheduleJob('* * * * *', checkBirthdays); // Runs every minute

