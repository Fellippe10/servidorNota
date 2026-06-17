const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Mercado Pago SDK
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN || '' });

// ROTA: Criar Preferência de Pagamento (Mercado Pago)
app.post('/create-preference', async (req, res) => {
    try {
        const { title, amount, quantity, back_url } = req.body;
        const preference = new Preference(mpClient);
        const result = await preference.create({
            body: {
                items: [{
                    title: title || 'Agendamento Barbearia',
                    quantity: quantity || 1,
                    unit_price: Number(amount),
                    currency_id: 'BRL',
                }],
                payment_methods: {
                    excluded_payment_types: [],
                    installments: 1,
                },
            }
        });
        res.json({ id: result.id, init_point: result.init_point, sandbox_init_point: result.sandbox_init_point });
    } catch (e) {
        console.error('[MP ERRO]', e.message);
        res.status(400).json({ error: e.message });
    }
});

// ROTA: Processar Pagamento (Checkout Transparente / Bricks)
app.post('/process-payment', async (req, res) => {
    try {
        const { token, issuer_id, payment_method_id, transaction_amount, installments, payer, description } = req.body;
        
        const payment = new Payment(mpClient);
        const result = await payment.create({
            body: {
                token,
                issuer_id,
                payment_method_id,
                transaction_amount: Number(transaction_amount),
                installments: Number(installments) || 1,
                description: description || 'Agendamento Barbearia',
                payer: {
                    email: payer?.email,
                    identification: payer?.identification,
                },
            }
        });

        console.log(`[MP] Pagamento criado: ${result.id} - Status: ${result.status}`);
        res.json({
            id: result.id,
            status: result.status,
            status_detail: result.status_detail,
            payment_method_id: result.payment_method_id,
            // Dados para Pix (QR Code)
            point_of_interaction: result.point_of_interaction,
        });
    } catch (e) {
        console.error('[MP PAGAMENTO ERRO]', e.message);
        res.status(400).json({ error: e.message });
    }
});

// ROTA: Verificar status do pagamento (para polling do Pix)
app.get('/payment-status/:id', async (req, res) => {
    try {
        const payment = new Payment(mpClient);
        const result = await payment.get({ id: req.params.id });
        res.json({
            id: result.id,
            status: result.status,
            status_detail: result.status_detail,
        });
    } catch (e) {
        console.error('[MP STATUS ERRO]', e.message);
        res.status(400).json({ error: e.message });
    }
});

// WEBHOOK: Receber notificações do Mercado Pago
app.post('/webhook/mercadopago', async (req, res) => {
    try {
        const { type, data } = req.body;
        if (type === 'payment') {
            const payment = new Payment(mpClient);
            const paymentData = await payment.get({ id: data.id });
            console.log(`[MP] Pagamento ${paymentData.id} - Status: ${paymentData.status}`);
            if (paymentData.status === 'approved') {
                console.log('✅ Pagamento aprovado via Mercado Pago!', paymentData.id);
                // TODO: Atualizar Supabase (Agendamento -> Status 'pago')
            }
        }
        res.sendStatus(200);
    } catch (e) {
        console.error('[MP WEBHOOK ERRO]', e.message);
        res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
    console.log(`🚀 Microserviço de Pagamentos rodando na porta ${PORT}`);
});
