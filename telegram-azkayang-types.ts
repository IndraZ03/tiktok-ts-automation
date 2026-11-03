export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  reply_to_message?: TelegramMessage;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  inline_message_id?: string;
  chat_instance: string;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramChatMember {
  user: TelegramUser;
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
}

export interface AzkayangStoreData {
  chatId: number | null;
  chatTitle: string | null;
  updateOffset?: number;
  grokAccounts: [string, string];
  tinggalBobok: {
    enabled: boolean;
    timeWib: string; // HH:mm
    promptFile: string | null;
    bahanFolder: string | null;
    lastRunDate: string | null; // YYYY-MM-DD
  };
}

export type WizardStep =
  | 'IDLE'
  | 'CHOOSE_BATCH'
  | 'CHOOSE_BAHAN'
  | 'CHOOSE_PROMPT'
  | 'CONFIRM_GENERATE'
  | 'WAITING_NEW_FOLDER_NAME'
  | 'WAITING_UPLOAD_PHOTO'
  | 'WAITING_PROMPT_NAME'
  | 'WAITING_PROMPT_TEXT'
  | 'WAITING_BOBOK_TIME'
  | 'WAITING_BOBOK_PROMPT'
  | 'WAITING_BOBOK_BAHAN';

export interface UserWizardSession {
  userId: number;
  chatId: number;
  step: WizardStep;
  payload?: {
    batchCount?: number;
    bahanFolder?: string;
    promptFile?: string;
    tempFolderName?: string;
    tempPromptName?: string;
  };
  updatedAt: number;
}

export interface BatchGenerationTask {
  id: string;
  chatId: number;
  batchCount: number;
  bahanFolder: string;
  promptFile: string;
  triggeredBy: string;
  progressMessageId?: number;
}
