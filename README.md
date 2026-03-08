# Trading Webhook System

A **port-80 webhook server** that receives TradingView Pine Script alerts and automatically executes trades on **Topstep** (via Tradovate) and **Lucid Markets**.

---

## Architecture

```
TradingView Alert
      │
      ▼  POST http://<your-server>/webhook/<token>
┌─────────────────────────────┐
│   Express Server (port 80)  │
│                             │
│  1. Validate webhook token  │
│  2. Parse alert body        │
│  3. Route to broker         │
│  4. Log order result        │
└────────────┬────────────────┘
             │
     ┌───────┴────────┐
     ▼                ▼
 Topstep           Lucid Markets
 (Tradovate API)   (REST API)
```

---

## Quick Start

### 1. Clone & install

```bash
git clone <repo-url>
cd App
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your settings
nano .env
```

### 3. Start the server

```bash
# Production
sudo npm start          # needs sudo for port 80

# Development (auto-reload)
sudo npx nodemon src/server.js
```

---

## API Reference

### Authentication

#### Register
```
POST /auth/register
Content-Type: application/json

{
  "username": "alice",
  "email": "alice@example.com",
  "password": "securePass123"
}
```

#### Login
```
POST /auth/login
Content-Type: application/json

{
  "email": "alice@example.com",
  "password": "securePass123"
}

→ { "token": "eyJ..." }
```

---

### Webhook Management (requires Bearer JWT)

#### Create a Webhook
```
POST /webhooks
Authorization: Bearer <token>
Content-Type: application/json

{
  "label": "My ES Strategy",
  "broker": "topstep",
  "brokerConfig": {
    "username":  "tradovate_user",
    "password":  "tradovate_pass",
    "appId":     "your_app_id",
    "accountId": 123456,
    "sim":       false
  }
}
```

Response includes your unique **webhook URL** to paste into TradingView:
```json
{
  "webhook": {
    "webhookUrl": "http://your-server/webhook/abc123def456...",
    "tradingViewSetup": {
      "alertMessageFormat": {
        "action":  "{{strategy.order.action}}",
        "ticker":  "{{ticker}}",
        "price":   "{{close}}",
        "qty":     "{{strategy.order.contracts}}",
        "comment": "{{strategy.order.comment}}"
      }
    }
  }
}
```

#### List Webhooks
```
GET /webhooks
Authorization: Bearer <token>
```

#### Update Webhook
```
PUT /webhooks/:id
Authorization: Bearer <token>

{ "active": false }   ← disable without deleting
```

#### Delete Webhook
```
DELETE /webhooks/:id
Authorization: Bearer <token>
```

---

### TradingView Alert Receiver (PUBLIC — no auth)

```
POST /webhook/<token>
Content-Type: application/json

{
  "action":  "buy",
  "ticker":  "ESH2026",
  "price":   5250.00,
  "qty":     1
}
```

Also accepts plain text: `"buy ES 1"`

---

### User

```
GET /user/me          ← profile
GET /user/orders      ← order history (add ?limit=50)
```

---

## TradingView Setup Guide

1. Open **TradingView** → Create or edit a **strategy alert**
2. In **Notifications**, enable **Webhook URL**
3. Paste your webhook URL: `http://your-server/webhook/<token>`
4. In the **Alert message** body, paste:

```json
{
  "action":  "{{strategy.order.action}}",
  "ticker":  "{{ticker}}",
  "price":   {{close}},
  "qty":     {{strategy.order.contracts}},
  "comment": "{{strategy.order.comment}}"
}
```

5. Save the alert. Every time the strategy fires, the trade executes automatically.

---

## Broker Configuration

### Topstep (Tradovate)

| Key | Description |
|-----|-------------|
| `username` | Tradovate login username |
| `password` | Tradovate login password |
| `appId` | App ID from Tradovate developer portal |
| `accountId` | Numeric account ID |
| `sim` | `true` for demo server, `false` for live |

Get your App ID at: https://trader.tradovate.com → Settings → API Access

### Lucid Markets

| Key | Description |
|-----|-------------|
| `apiKey` | Lucid API key |
| `apiSecret` | Lucid API secret (used for HMAC request signing) |
| `accountId` | Your Lucid account ID |

---

## Alert Format Reference

| Field | TradingView Variable | Example |
|-------|---------------------|---------|
| `action` | `{{strategy.order.action}}` | `"buy"` / `"sell"` |
| `ticker` | `{{ticker}}` | `"ESH2026"` |
| `price` | `{{close}}` | `5250.00` |
| `qty` | `{{strategy.order.contracts}}` | `2` |
| `comment` | `{{strategy.order.comment}}` | `"EMA Crossover"` |

Also accepted: `long` / `short` / `close` / `flat` / `exit` as action values.

---

## Health Check

```
GET /health
→ { "status": "ok", "uptime": 123.4 }
```
