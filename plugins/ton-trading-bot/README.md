# TON Trading Bot

Autonomous trading platform for TON with a 9-step trading pipeline + mode switching: fetch data → analyze signal → validate risk → generate plan → simulate → execute → record → update analytics.

**⚠️ WARNING: TRADING CRYPTOSETS NEGATIVELY AFFECTS DEALS. ⚠️**

**Do not trade with money you cannot afford to lose.**
**This plugin is a tool for autonomous trading. Use it at your own risk.**
**We provide the tool, not financial advice or guaranteed results.**
**Any losses are your responsibility.**

**Developed by Tony (AI Agent) under supervision of Anton Poroshin**
**Development Studio:** https://github.com/xlabtg

## Features

- **9-Step Trading Pipeline**: Complete autonomous trading workflow
- **Mode Switching**: Toggle between simulation and real trading
- **AI Signal Generation**: Analysis of market data with confidence scores
- **Risk Validation**: Balance checks, position sizing, risk multipliers
- **Dual DEX Support**: DeDust and STON.fi integration
- **Simulation Mode**: Test trades with virtual balance (default: 1000 TON)
- **Real Mode**: Execute trades with real money on TON
- **Portfolio Analytics**: Real-time PnL, win rate, trade metrics
- **Journal System**: Complete trading history with results

## Tools

| Tool | Description | Category | Mode |
|------|-------------|----------|------|
| `ton_fetch_data` | Fetch TON price, tokens, DEX liquidity, volume | Data-bearing | Both |
| `ton_analyze_signal` | AI analysis → signal (buy/sell/hold) with confidence | Data-bearing | Both |
| `ton_validate_risk` | Validate risk: balance, max trade %, risk level | Action | Both |
| `ton_generate_plan` | Generate trade plan: entry, exit, stop-loss, position size | Action | Both |
| `ton_simulate_trade` | Simulate trade with results (no real money) | Action | Simulation |
| `ton_execute_trade` | Execute real trade on TON DEX (DeDust/STON.fi) | Action | Real |
| `ton_record_result` | Record trade result (sell) and update PnL | Action | Both |
| `ton_update_analytics` | Update portfolio analytics: PnL, win rate, metrics | Action | Both |
| `ton_get_portfolio` | Get portfolio overview with holdings and recent trades | Data-bearing | Both |
| `ton_switch_mode` | Switch between simulation and real trading modes | Action | Both |

## Installation

```bash
mkdir -p ~/.teleton/plugins
cp -r plugins/ton-trading-bot ~/.teleton/plugins/
```

## Configuration

Edit `~/.teleton/config.yaml` to set trading parameters:

```yaml
plugins:
  ton-trading-bot:
    enabled: true
    riskLevel: "medium"
    maxTradePercent: "10"
    minBalanceForTrading: 1
    useDedust: true
    enableSimulation: true
    autoTrade: true
    mode: "simulation"        # "simulation" or "real"
    simulationBalance: 1000  # Simulated balance for testing
    requireManualConfirm: true  # Require confirmation for real trades
```

## Mode Switching

### Switch to Simulation Mode

```
Switch to simulation mode with balance 1000
```

Or manually:

```
Switch to simulation mode with amount: 500
```

**Features in Simulation Mode:**
- ✅ Virtual balance (default: 1000 TON)
- ✅ No real money spent
- ✅ Safe testing environment
- ✅ All 9 trading tools available
- ✅ Automatic balance updates

### Switch to Real Mode

```
Switch to real trading mode
```

**Prerequisites:**
- ⚠️ Must have TON wallet initialized
- ⚠️ Must have balance in wallet
- ⚠️ Require manual confirmation enabled
- ⚠️ **This is REAL money trading. Use at your own risk.**

**Features in Real Mode:**
- ✅ Real money trading
- ✅ DeDust/STON.fi integration
- ✅ Real wallet balance
- ✅ Transaction verification
- ✅ PnL on real funds

## Usage Examples

### In Simulation Mode

```
"Switch to simulation mode with balance 1000"
"Fetch market data"
"Analyze signal for TON"
"Simulate buying 2 TON"
"Get portfolio overview"
```

### In Real Mode

```
"Switch to real trading mode"
"Fetch market data"
"Analyze signal for TON"
"Validate risk for buying 2 TON"
"Execute trade: buy 2 TON"
"Get portfolio overview"
```

### Switch Between Modes

```
"Switch to simulation mode with balance 500"
(perform trades)
"Switch to real mode"
(perform real trades)
```

## Trading Pipeline

1. **Switch Mode**: Toggle between simulation/real
2. **Fetch Market Data**: Get current prices, volumes, DEX liquidity
3. **Analyze Signal**: AI analysis → buy/sell/hold with confidence
4. **Validate Risk**: Check balance, max trade %, risk level
5. **Generate Plan**: Entry price, exit targets, stop-loss, position size
6. **Simulate Trade**: Test trade without real money (simulation mode)
7. **Execute Trade**: Real trade on TON DEX (real mode)
8. **Record Result**: Update journal with PnL
9. **Update Analytics**: Refresh portfolio metrics
10. **Get Portfolio**: View current holdings and performance

## Risk Management

- **Position Sizing**: Maximum trade as % of balance (default 10%)
- **Risk Multipliers**: Low=30%, Medium=50%, High=80% of max trade
- **Stop-Loss**: 5% from entry price
- **Take-Profit**: 10% from entry price
- **Risk Per Trade**: Calculated as stop-loss percentage
- **Manual Confirmation**: Require confirmation for real trades (default: true)

## Code-Level Risk Protections

The plugin includes built-in protections to prevent accidental or reckless trading:

### 1. Maximum Trade Percentage
- By default, **no single trade can exceed 10% of your balance**
- Users cannot accidentally trade 100% of their balance in one go
- Can be adjusted in config (recommended: keep <= 10%)

### 2. Risk Multipliers
- Low risk: Only 30% of max trade size
- Medium risk: 50% of max trade size
- High risk: 80% of max trade size
- Prevents overexposure based on risk level

### 3. Minimum Balance Check
- Trading disabled if balance below configured minimum
- Default minimum: 1 TON
- Prevents trading with insufficient funds

### 4. Manual Confirmation
- Real trades require explicit confirmation
- Clear warning before execution
- No automatic execution without user consent

### 5. Mode Isolation
- Simulation mode: Completely isolated, no real money touched
- Real mode: Only available after explicit switch
- Can't accidentally start trading in simulation mode

### 6. Logging and Audit Trail
- Every trade is logged with full details
- Timestamp, amount, price, signal, result
- Complete audit trail for review

## Database Tables

- `trading_journal`: Complete trade history with results
- `market_cache`: Cached market data with TTL
- `simulation_history`: Simulated trades
- `portfolio_metrics`: Portfolio analytics over time
- `simulation_balance`: Simulation balance tracking

## Legal Disclaimer

**COPYRIGHT 2026 TONY (AI AGENT) UNDER SUPERVISION OF ANTON POROSHIN**

**THIS PLUGIN IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.**

**THE DEVELOPERS DO NOT PROVIDE FINANCIAL ADVICE.**
**CRYPTOCURRENCY TRADING IS HIGHLY VOLATILE AND RISKY.**
**PAST PERFORMANCE IS NOT INDICATIVE OF FUTURE RESULTS.**
**YOU ARE RESPONSIBLE FOR YOUR OWN FINANCIAL DECISIONS.**
**USE THIS TOOL AT YOUR OWN RISK.**

## Notes

- Plugin uses Pattern B (SDK) for full TON integration
- Requires TON wallet with balance for real mode
- DEX integration requires DeDust or STON.fi support
- Simulation mode is recommended for testing
- Always validate risk before executing trades
- Auto-trade can be disabled in config
- Manual confirmation required for real trades (default)
- Maximum trade % protection in place (default: 10%)
- Risk multipliers prevent overexposure

## Mode Comparison

| Feature | Simulation Mode | Real Mode |
|---------|----------------|-----------|
| Money Spent | $0 | Real money |
| Balance | Virtual | Real wallet |
| DEX Execution | No | Yes |
| PnL | Virtual | Real |
| Safe Testing | ✅ Yes | ❌ No |
| Quick Setup | ✅ Yes | ⚠️ Wallet required |
| Best For | Testing & Learning | Actual Trading |

---

**Developed by:** Tony (AI Agent)
**Supervisor:** Anton Poroshin
**Studio:** https://github.com/xlabtg
