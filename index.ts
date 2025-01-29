import { Bot, type Context, session, type SessionFlavor,} from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { CommandGroup, commandNotFound, commands , type CommandsFlavor, } from "@grammyjs/commands";
import type { Message, SharedUser, } from "grammy/types";
import { hydrate, type HydrateFlavor, } from "@grammyjs/hydrate";
import {
  type Conversation,
  type ConversationFlavor,
  conversations,
  createConversation,
} from "@grammyjs/conversations";
import { Database } from 'bun:sqlite';
const schedule = require('node-schedule');
import 'dotenv/config';


type BotContextInside = HydrateFlavor<Context & CommandsFlavor & SessionFlavor<{}>>;
type BotContext = ConversationFlavor<BotContextInside>;
type BotConversation = Conversation<BotContext, BotContextInside>;
// type DBUser = {id: number, username: string | undefined, first: string, last: string | undefined, full: string} & Object;
const token = process.env.BOT_TOKEN as string;

class User extends Object {
  id!: number;
  username?: string;
  first!: string;
  last?: string;
  full?: string = this.first + ' ' + this.last;
  birthday?: Date;
}

class Chat extends Object {
  id!: number;
  title?: string;
  username?: string;
  type?: string;
}

class Birthday extends Object {
  user_id!: number;
  date?: string;
}

class chatUser extends Object {
  user_id!: number;
  chat_id!: number;
}

class BannedUser extends chatUser {
  banned_until?: Date;
}

class InviteLink extends Object {
  link!: string;
  user_id!: number;
  chat_id!: number;
}

const bot = new Bot<BotContext>(token, {client: {apiRoot: 'https://nix.mercusysddns.com/tdlib'}});

const db = new Database('./config.db', { create: true, strict: true }); //! For production, persistent data
// const db = new Database(':memory:', { create: true, strict: true }); //! For testing, in-memory only, reset on reload

console.log('init db');

db.query('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, first TEXT, last TEXT, full GENERATED ALWAYS AS (first || " " || last) VIRTUAL, username TEXT)').run();
db.query('CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY, title TEXT, username TEXT, type TEXT)').run();
db.query('CREATE TABLE IF NOT EXISTS birthdays (user_id INTEGER PRIMARY KEY REFERENCES users (id) ON UPDATE CASCADE, date TEXT)').run();
db.query('CREATE TABLE IF NOT EXISTS chat_users (chat_id INTEGER REFERENCES chats (id) ON UPDATE CASCADE, user_id INTEGER REFERENCES users (id) ON UPDATE CASCADE)').run();
db.query('CREATE TABLE IF NOT EXISTS banned_users (user_id INTEGER REFERENCES users (id) ON UPDATE CASCADE, chat_id INTEGER REFERENCES chats (id) ON UPDATE CASCADE, banned_until INTEGER)').run();
db.query('CREATE TABLE IF NOT EXISTS invite_links (link TEXT, chat_id INTEGER REFERENCES chats (id) ON UPDATE CASCADE, user_id INTEGER REFERENCES users (id) ON UPDATE CASCADE)').run();

console.log('done');
const getUserByUsername = db.prepare('SELECT * FROM users WHERE username = $username').as(User);
const getUserById = db.prepare('SELECT * FROM users WHERE id = $id').as(User);
const getChatById = db.prepare('SELECT * FROM chats WHERE id = $id').as(Chat);

bot.api.config.use(autoRetry({maxRetryAttempts: 5, maxDelaySeconds: 1800}));
bot.use(commands());
bot.use(hydrate());
bot.use(session({ initial: () => ({}) }));
bot.use(conversations());
bot.use(createConversation<BotContext, BotContextInside>(addUser));
bot.use(createConversation<BotContext, BotContextInside>(setBirthday));

const BotCommands = new CommandGroup<BotContext>({ignoreCase: true, targetedCommands: 'optional', matchOnlyAtStart: true});

BotCommands.command('return_user', 'Вернуть пользователя в группу').addToScope({type: 'all_chat_administrators'}, async (ctx) => {returnUser(ctx)});
BotCommands.command('add', 'Добавить пользователей в БД').addToScope({type: 'all_chat_administrators'}, (ctx) => {
  ctx.api.sendMessage(ctx.chat.id, 'Эта команда работает только в Личных Сообщениях', {reply_markup: {inline_keyboard: [[{text: 'Открыть в ЛС', url: 'https://t.me/AGSoft_BirthayManagerBot?start=addUser '+ctx.chat!.id}]]}});
  }).addToScope({type: 'all_private_chats'}, async (ctx) => {
    const args = ctx.msg!.text?.split(' ').slice(1) as string[];
    await ctx.conversation.enter('addUser', args);
  });
BotCommands.command('start', 'add для кнопок').addToScope({type: 'all_private_chats'}, async (ctx) => {
  const action = ctx.msg!.text?.split(' ')[1] || 'addUser';
  const args = ctx.msg!.text?.split(' ').slice(2) as string[];
  await ctx.conversation.enter(action, args)}).addToScope({type: 'all_group_chats'}, async (ctx) => {
    ctx.api.sendMessage(ctx.chat.id, 'комнды рекомендуемые для запуска бота:', {reply_markup: {inline_keyboard: [[{text: 'Добавить id пользователей в чат (для админов чатов)', url: 'https://t.me/AGSoft_BirthayManagerBot?start=adduser '+ ctx.chat!.id}],[{text: 'Установить день рождения (Для всех пользователей)', url: 'https://t.me/AGSoft_BirthayManagerBot?start=setBirthday'}]]}});
  });
BotCommands.command('set_birthday', 'Установить свой день рождения').addToScope({type: 'all_private_chats'}, async (ctx) => {await ctx.conversation.enter('setBirthday')});

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

bot.on(':new_chat_members', async (ctx) => {
  console.log(`got chat member: `, ctx.message!.new_chat_members);
  const newMembers = ctx.message!.new_chat_members;

  for (const member of newMembers) {
    const exists = getUserById.get({ id: member.id });
    const birthdaySet = db.query('SELECT * FROM birthdays WHERE user_id = $userId').as(Birthday).get({ userId: member.id });

    if (birthdaySet) {
      console.log(`Skipping member with ID ${member.id} as they already have a birthday set.`);
      continue;
    }

    if (exists) {
      console.log(exists);
      checkUser(exists);
    } else {
      console.log(member.id, "doesn't exist!");
      db.query('insert into users (id, username, first, last) values ($id, $username, $first, $last)').run({ id: member.id, username: member.username as string, first: member.first_name as string, last: member.last_name as string });
    }

    ctx.api.sendMessage(ctx.chat!.id, `Добро пожаловать, ${member.username ? member.username : (member.first_name + member.last_name)}!\nПожалуйства воспользуйтесь кнопой ниже, чтобы установить дату своего рождения!`, { reply_markup: { inline_keyboard: [[{ text: 'Установить день рождения', url: 'https://t.me/AGSoft_BirthayManagerBot?start=setBirthday' }]] } });
  }
});

bot.on([':migrate_from_chat_id', ':migrate_to_chat_id'], async (ctx) => {
  db.query('UPDATE chats SET id = $id WHERE id = $old_id').run({id: ctx.msg!.migrate_to_chat_id!.toString(), old_id: ctx.msg!.migrate_from_chat_id!.toString()});
});

bot.on('chat_join_request', (ctx) => {
  const request = ctx.chatJoinRequest;
  const data = db.query('SELECT * FROM invite_links WHERE link = $link').as(InviteLink).get({link: request.invite_link!.invite_link}) as InviteLink;
  if (data) {
    if (data.user_id == ctx.chatJoinRequest.from.id) {
      ctx.approveChatJoinRequest(ctx.chatJoinRequest.from.id);
      ctx.revokeChatInviteLink(data.link);
    } else {
      ctx.declineChatJoinRequest(ctx.chatJoinRequest!.from!.id);
    }
  } else {
    ctx.declineChatJoinRequest(ctx.chatJoinRequest!.from!.id);
  } 
});

// bot.on(['msg', 'edit'], async (ctx) => {
//   console.log(`got message: ${ctx.msg.text}`);
//   checkUser(ctx);
// });

bot.catch((err) => {console.log(err)});

bot.start({timeout: 900, allowed_updates: ['message', 'chat_member', 'edited_message', 'message_reaction', 'my_chat_member'], drop_pending_updates: true});

async function returnUser(ctx: BotContext) {
  let userid: number = 0;
  const identitificator: string | number | undefined = ctx.msg!.text!.split(' ')[1];
  if (identitificator) {
    try {
      userid = parseInt(identitificator, 10);
    } catch {
      userid = (getUserByUsername.get({username: identitificator}) as User).id;
    }
      const link = (await ctx.api.createChatInviteLink(ctx.chat!.id, {creates_join_request: true})).invite_link;
      db.query('INSERT INTO invite_links (link, user_id, chat_id) VALUES ($link, $userid, $chat_id)').run({link, userid, chat_id: ctx.chat!.id})
      console.log(link);
      ctx.unbanChatMember(userid);
      ctx.api.sendMessage(userid, `Поздравляем с прошедим днём рождения!(или нет)\nЧтобы вернутся в чат, восползуйтесь ссылкой: ${link}`);
  }
}


function checkUser(user: User) {
  let userCheck = getUserById.get({id: user.id});
  if (!userCheck) {db.query('insert into users (id, username, first, last) values ($id, $username, $first, $last)').run({id: user.id, username: user.username as string, first: user.first as string, last: user.last as string}); return 'Added'}
  const diffKeys = Object.keys(user).filter(key => user[key as keyof User] !== userCheck[key as keyof User]);
  if (Object.keys(userCheck).filter(key => key !== 'id').every((key) => userCheck[key as keyof User] === user[key as keyof User])) {return 'Skipped'} else {
    const status = updateUserInDb(user, diffKeys);
    return status;
  }
}

/**
 * Updates a user in the database with the specified changes.
 * If `diffKeys` is not provided, all keys will be updated.
 *
 * @param {User} user - The user object containing updated data.
 * @param {string[]} [diffKeys] - Optional array of keys to update. If not provided, all fields will be updated.
 */
function updateUserInDb(user: User, diffKeys?: string[]) {
  try {
    const keysToUpdate = diffKeys || [];
    if (keysToUpdate.length > 0) {
      const setClause = keysToUpdate.map(key => `${key} = $${key}`).join(', ');
      const updateStmt = `UPDATE users SET ${setClause} WHERE id = $id`;
      const params = keysToUpdate.reduce((acc, key) => {
        acc[key] = user[key as keyof User];
        return acc;
      }, { id: user.id } as Record<string, any>);

      db.query(updateStmt).run(params);
      return 'Updated'
  }
  return 'Skipped'
  } catch {
    return 'Failed'
  }
}

async function addUser(conversation: BotConversation, ctx: BotContextInside, args?: string[]) {
  let status: any[] = [];
  let chat_id;
  const arg: number | undefined = args ? parseInt(args[0], 10) : ctx.msg!.text!.split(' ')[1] ? parseInt(ctx.msg!.text!.split(' ')[1], 10) : undefined;
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
    chat_id = (await conversation.waitFor(':chat_shared')).msg;
    chat_id = chat_id!.chat_shared.chat_id;
  } else {
  // if (arg) {
    chat_id = arg;
  }
  console.log(chat_id);
  ctx.api.sendMessage(ctx.chat!.id, 'Теперь выберите пользователя/телей которых добавите в этот чат, или отправьте /me чтобы добавить себя!', {
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
    const userNew: User = {
      id: user.user_id,
      username: user.username,
      first: user.first_name!,
      last: user.last_name
    }
    const identifier = user.username ? user.username : user.user_id.toString();
    console.log(identifier);
    console.log(checkUser(userNew) as string);
    db.query('INSERT INTO chat_users (chat_id, user_id) VALUES ($chat_id, $user_id)').run({chat_id: chat_id, user_id: userNew.id});
    status.push([identifier, checkUser(userNew) as string] as string[]);
  });
  console.log(status);
  ctx.api.sendMessage(ctx.chat!.id, `Добавлено пользователей:\n${status.map((user) => {return `- ${user[0]}: ${user[1]}`}).join('\n')}`, {reply_markup: { remove_keyboard: true }});
}

/*
  * In prod will run every day
  * In dev will run every 15 seconds
*/
schedule.scheduleJob('*/15 * * * * *', checkBirthdays);

async function checkBirthdays() {
  const now = new Date();
  const twoWeeksFromNow = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  let birthdaysInTwoWeeks = db.query(`
    SELECT user_id FROM birthdays 
    WHERE date <= $twoWeeksFromNow
    AND user_id NOT IN (
      SELECT user_id FROM banned_users
    )
  `).as(Birthday).all({twoWeeksFromNow: twoWeeksFromNow.getTime()}) as Birthday[];
  // console.log('bdays in two weeks', birthdaysInTwoWeeks);
  if (birthdaysInTwoWeeks.length > 0) {
    // console.log((birthdaysInTwoWeeks.map(birthday => birthday.user_id)).toString());
    const users_chats = db.query('SELECT * FROM chat_users WHERE user_id IN ($userIds)').as(chatUser).all({userIds: (birthdaysInTwoWeeks.map(birthday => birthday.user_id)).toString()}) as chatUser[];
    // console.log(users_chats);
    users_chats.forEach(async (user_chat) => {
      const birthday = db.query('SELECT * FROM birthdays WHERE user_id = $user_id').as(Birthday).get({user_id: user_chat.user_id});
      try {
      bot.api.banChatMember(user_chat.chat_id, user_chat.user_id, {until_date: new Date(parseDate(birthday!.date!)).getTime() + 24 * 60 * 60 * 1000});
      db.query('INSERT INTO banned_users (user_id, chat_id, banned_until) VALUES ($user_id, $chat_id, $bannedUntil)').run({user_id: user_chat.user_id, chat_id: user_chat.chat_id, bannedUntil: new Date(parseDate(birthday!.date!)).getTime() + 24 * 60 * 60 * 1000});
      console.log(`banned ${user_chat.user_id} in ${user_chat.chat_id}`);
      } catch (error) {
        const user = getUserById.get({id: user_chat.user_id}) as User;
        bot.api.sendMessage(user_chat.chat_id, `Не удалось убрать пользователя из чата, возможно он является его владельцем или не состоит в нём\n${user.username ? `@${user.username}` : user.full ? `[${user.full}](tg:/user?id=${user.id})` : `[${user.first}](tg:/user?id=${user.id})`}, В качестве костыля, вам рекомендуется выключить уведомлния от этого чата`, {parse_mode: 'MarkdownV2'});
        db.query('INSERT INTO banned_users (user_id, chat_id, banned_until) VALUES ($user_id, $chat_id, $bannedUntil)').run({user_id: user_chat.user_id, chat_id: user_chat.chat_id, bannedUntil: new Date(parseDate(birthday!.date!)).getTime() + 24 * 60 * 60 * 1000});
      }
      db.query('DELETE FROM banned_users WHERE banned_until <= $date').run({date: now.getTime()});
    });
  }
}


async function setBirthday (conversation: BotConversation, ctx: BotContextInside) {
  const birthdaySet = db.query('SELECT * FROM birthdays WHERE user_id = $userId').as(Birthday).get({userId: ctx.from!.id});
  if (birthdaySet) {
    ctx.reply('У вас уже установлен день рождения, чтобы его изменить, обратитесь к @NiXTheDev');
    return;
  }
  ctx.reply('Введите дату в формате "ДД.ММ"\nВводите настоящую дату т.к. изменить её можно будет только через администрацию бота!');
  const message = (await conversation.waitFor('message:text')).msg!.text;
  const dateRegex = /^(\d{2})\.(\d{2})$/;
  const parsedDate = message.match(dateRegex);
  if (!parsedDate) {
    ctx.reply('Вы ввели дату не в том формате, пример: "28.07"\nВводите настоящую дату т.к. изменить её можно будет только через администрацию бота!\n(Отправьте команду повторно)');
    return;
  }
  const date = parseDate(parsedDate[1]+'.'+parsedDate[2]);
  db.query('INSERT INTO birthdays (user_id, date) VALUES ($userId, $date)').run({userId: ctx.from!.id, date: message});
  ctx.reply(`Ваш день рождения успешно установлен на ${date.toLocaleString('ru', { day: 'numeric', month: 'short' })}`);
  console.log(date.toLocaleString('ru', { day: 'numeric', month: 'short' }));
  return;
}

function parseDate (dateString: string): Date {
  const dateRegex = /^(\d{2})\.(\d{2})$/;
  const parsedDate = dateString.match(dateRegex);
  if (!parsedDate) {
    throw new Error('Wrong date format');
  }
  const today = new Date();
  const parsed = new Date(`${parsedDate[2]}.${parsedDate[1]}.${today.getFullYear()}`);
  if (parsed.getTime() < today.getTime()) {
    return new Date(`${parsedDate[2]}.${parsedDate[1]}.${today.getFullYear() + 1}`);
  }
  return parsed;
}
