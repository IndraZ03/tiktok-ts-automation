import fs from 'fs';
import { getGrokRateLimits } from './grok-uploader.js';
const ID_INSTANCE = "7103957889";
const API_TOKEN = "8eca423d65e444f3b9234c41252c4b8764533d7f18c643a8ad";
const API_URL = "https://7103.api.greenapi.com";
const TARGET_GROUP = "120363426226443899@g.us";
export async function sendWAMessage(msg) {
    const urlSend = `${API_URL}/waInstance${ID_INSTANCE}/sendMessage/${API_TOKEN}`;
    try {
        const res = await fetch(urlSend, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                chatId: TARGET_GROUP,
                message: msg
            })
        });
        if (!res.ok) {
            console.error(`Failed to send WA message: HTTP ${res.status}`);
        }
        else {
            console.log(`WA message sent: "${msg}"`);
        }
    }
    catch (e) {
        console.error(`Error sending WA message: ${e.message}`);
    }
}
export function notifyScheduleStarted(firstUploadTime, lastUploadTime) {
    // 1. Send the WhatsApp message
    const msg = `🚀 Schedule Baru Dimulai!\n📅 Upload Pertama: ${firstUploadTime}\n📅 Upload Terakhir: ${lastUploadTime}`;
    sendWAMessage(msg);
    // 2. Calculate reminderTime (5 hours before lastUploadTime)
    let reminderTime = "";
    try {
        const lastUploadDate = new Date(lastUploadTime.trim().replace(' ', 'T') + ':00');
        if (!isNaN(lastUploadDate.getTime())) {
            const reminderMs = lastUploadDate.getTime() - (5 * 60 * 60 * 1000);
            const reminderDate = new Date(reminderMs);
            // Format as YYYY-MM-DD HH:mm
            reminderTime = `${reminderDate.getFullYear()}-${String(reminderDate.getMonth() + 1).padStart(2, '0')}-${String(reminderDate.getDate()).padStart(2, '0')} ${String(reminderDate.getHours()).padStart(2, '0')}:${String(reminderDate.getMinutes()).padStart(2, '0')}`;
        }
    }
    catch (e) {
        console.error("Error calculating reminder time:", e);
    }
    // 3. Save to file
    const file = './whatsapp-schedule-info.json';
    const data = {
        firstUploadTime,
        lastUploadTime,
        reminderTime,
        reminderSent: false
    };
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    }
    catch (e) {
        console.error("Error writing schedule info:", e);
    }
}
export function startWAPolling() {
    // Start checkReminders every 1 minute
    setInterval(() => {
        const file = './whatsapp-schedule-info.json';
        if (!fs.existsSync(file))
            return;
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (data.reminderTime && !data.reminderSent) {
                const now = Date.now();
                const reminderTimeMs = new Date(data.reminderTime.trim().replace(' ', 'T') + ':00').getTime();
                if (now >= reminderTimeMs) {
                    const lastUploadMs = new Date(data.lastUploadTime.trim().replace(' ', 'T') + ':00').getTime();
                    if (now < lastUploadMs) {
                        sendWAMessage("⚠️ Peringatan: Schedule anda hampir habis! (Sisa kurang dari 5 jam)");
                    }
                    data.reminderSent = true;
                    fs.writeFileSync(file, JSON.stringify(data, null, 2));
                }
            }
        }
        catch (e) {
            console.error("Error checking reminders:", e);
        }
    }, 60000);
    // Start polling incoming messages
    const urlReceive = `${API_URL}/waInstance${ID_INSTANCE}/receiveNotification/${API_TOKEN}?receiveTimeout=5`;
    (async () => {
        console.log("WhatsApp polling started...");
        while (true) {
            try {
                const response = await fetch(urlReceive);
                if (!response.ok) {
                    await new Promise(r => setTimeout(r, 10000));
                    continue;
                }
                const data = await response.json();
                if (data && data.receiptId) {
                    const receiptId = data.receiptId;
                    const body = data.body;
                    if (body && body.typeWebhook === 'incomingMessageReceived') {
                        const chatId = body.senderData?.chatId;
                        const messageData = body.messageData;
                        if (chatId === TARGET_GROUP && messageData && messageData.typeMessage === 'textMessage') {
                            const text = messageData.textMessageData?.textMessage?.trim();
                            if (text === '/list_schedule') {
                                const scheduleFile = './whatsapp-schedule-info.json';
                                if (!fs.existsSync(scheduleFile)) {
                                    await sendWAMessage("Belum ada schedule yang terdaftar.");
                                }
                                else {
                                    try {
                                        const sData = JSON.parse(fs.readFileSync(scheduleFile, 'utf-8'));
                                        const msg = `📋 Informasi Schedule Terakhir:\n- Mulai: ${sData.firstUploadTime}\n- Selesai: ${sData.lastUploadTime}`;
                                        await sendWAMessage(msg);
                                    }
                                    catch {
                                        await sendWAMessage("Gagal membaca informasi schedule.");
                                    }
                                }
                            }
                            else if (text === '/list_grok') {
                                try {
                                    const rateLimits = getGrokRateLimits();
                                    const keys = Object.keys(rateLimits);
                                    if (keys.length === 0) {
                                        await sendWAMessage("🤖 Status Grok: Available");
                                    }
                                    else {
                                        let msg = "🤖 Status Grok Rate Limit:\n";
                                        for (const key of keys) {
                                            const limit = rateLimits[key];
                                            const name = key.replace('grok-state-', '').replace('.json', '');
                                            const avail = limit.availableAt || "tidak diketahui";
                                            msg += `- State ${name}: Limit sampai ${avail}\n`;
                                        }
                                        await sendWAMessage(msg);
                                    }
                                }
                                catch (e) {
                                    await sendWAMessage(`Gagal mengambil status Grok: ${e.message}`);
                                }
                            }
                        }
                    }
                    // Delete notification to acknowledge
                    const urlDelete = `${API_URL}/waInstance${ID_INSTANCE}/deleteNotification/${API_TOKEN}/${receiptId}`;
                    await fetch(urlDelete, { method: 'DELETE' }).catch(() => { });
                }
            }
            catch (e) {
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    })();
}
