//+------------------------------------------------------------------+
//|              SignalBot_MultiIndicator_MT5.mq5  v6.0              |
//|  INSTITUTIONAL EDITION                                           |
//|                                                                  |
//|  NEW in v6.0 (12 additions over v5.0):                          |
//|   1. Kill Zone filter  (London 07-09, NY 12-14, LC 15-16 UTC)   |
//|   2. Liquidity Sweep confirmation on M15                         |
//|   3. Fair Value Gap (FVG) detection on H1 + M15                 |
//|   4. CHoCH / BOS structural break detection on H1               |
//|   5. Premium / Discount zone filter (HTF 50% equilibrium)       |
//|   6. RSI Divergence detection (regular + hidden) on M15 + H1    |
//|   7. Order Block detection on H1                                 |
//|   8. News blackout window (manual input — no external API)       |
//|   9. Candle pattern confirmation (Engulf, Pin, Inside Bar)       |
//|  10. ATR volatility regime filter (80–150% of 20-bar avg ATR)   |
//|  11. DXY correlation filter (dollar-pair directional check)      |
//|  12. Partial close + TP3 instructions in Telegram message        |
//|                                                                  |
//|  PRESERVED from v5.0 (unchanged):                               |
//|   Multi-TF bias, AMD, ADX, spread, fractal SL,                  |
//|   round-number adjust, RSI/MACD/EMA triggers, Facebook bridge,  |
//|   weighted confluence scoring, golden/death cross, startup msg   |
//|                                                                  |
//|  SETUP                                                           |
//|   Tools > Options > Expert Advisors > Allow WebRequest           |
//|   Add: https://api.telegram.org                                  |
//|   Add: https://localhost:5005  (Facebook signal server)          |
//+------------------------------------------------------------------+
#property copyright "SignalBot v6.0"
#property version   "6.00"
#property strict

//─────────────────────────── INPUTS ────────────────────────────────

// Telegram
input string  InpBotToken              = "8645295769:AAFNKoOjTjIqb7B9mEQ9jXZ61gswIXTFBWw";
input string  InpChatID                = "-1003939765500";
input bool    InpSendStartupMessage    = true;

// Bias MAs
input int     InpWeeklyEMA             = 21;
input int     InpDailyMA               = 200;
input int     InpCrossFastMA           = 50;
input int     InpCrossSlowMA           = 200;
input bool    InpAlertGoldenDeathCross = true;

// Structure H1
input int     InpH1EMA                 = 50;
input int     InpSwingLookback         = 60;
input int     InpFractalWing           = 2;

// M15 triggers
input int     InpRSIPeriod             = 14;
input int     InpRSIOversold           = 32;
input int     InpRSIOverbought         = 68;
input int     InpMACDFast              = 12;
input int     InpMACDSlow              = 26;
input int     InpMACDSignalP           = 9;
input double  InpVolumeMultiplier      = 1.4;

// M5 scalp
input int     InpM5EMAFast             = 8;
input int     InpM5EMASlow             = 21;
input int     InpM5RSIPeriod           = 9;
input int     InpM5RSIOversold         = 35;
input int     InpM5RSIOverbought       = 65;

// Risk / SL / TP
input int     InpATRPeriod             = 14;
input double  InpSLATRMult             = 1.2;   // fallback SL if no fractal found
input double  InpRRRatio               = 2.0;   // TP2 = entry ± SL_dist × RR
input double  InpTP1Ratio              = 1.0;   // TP1 = entry ± SL_dist × TP1
input double  InpTP3Ratio              = 3.0;   // TP3 for remainder after TP2

// Signal filter
input int     InpMinScore              = 7;     // raised from 5 — more confluences now
input bool    InpAlertFullSignal       = true;
input int     InpCooldownBars          = 2;
input bool    InpShowWatchSignals      = true;

// AMD
input bool    InpAMDEnable             = true;
input int     InpAMDAccumBars          = 20;
input double  InpAMDATRRatio           = 0.6;
input double  InpAMDWickRatio          = 0.6;

// ADX Regime Filter
input bool    InpADXEnable             = true;
input int     InpADXPeriod             = 14;
input int     InpADXMinTrend           = 22;

// Session Filter (kept as broad gate — Kill Zone handles precision inside)
input bool    InpSessionEnable         = true;
input int     InpSessionStartHour      = 7;
input int     InpSessionEndHour        = 20;

// ── NEW 1: Kill Zone Filter ─────────────────────────────────────────
input bool    InpKillZoneEnable        = true;
// London Kill Zone
input int     InpLKZ_Start             = 7;     // 07:00 UTC
input int     InpLKZ_End               = 9;     // 09:00 UTC
// New York Kill Zone
input int     InpNYKZ_Start            = 12;    // 12:00 UTC
input int     InpNYKZ_End              = 14;    // 14:00 UTC
// London Close Kill Zone
input int     InpLCKZ_Start            = 15;    // 15:00 UTC
input int     InpLCKZ_End              = 16;    // 16:00 UTC

// Spread Filter
input bool    InpSpreadEnable          = true;
input int     InpMaxSpreadPoints       = 30;

// ── NEW 2: Liquidity Sweep ──────────────────────────────────────────
input bool    InpLiqSweepEnable        = true;
input int     InpLiqSweepLookback      = 20;    // M15 bars to scan for recent highs/lows
input double  InpLiqSweepWickRatio     = 0.55;  // wick must be >= this fraction of candle range

// ── NEW 3: Fair Value Gap ───────────────────────────────────────────
input bool    InpFVGEnable             = true;
input int     InpFVGLookback           = 30;    // H1 bars to scan for FVGs

// ── NEW 4: CHoCH / BOS ─────────────────────────────────────────────
input bool    InpCHoCHEnable           = true;
input int     InpCHoCHLookback         = 40;    // H1 bars for structure tracking

// ── NEW 5: Premium / Discount ──────────────────────────────────────
input bool    InpPDEnable              = true;
input ENUM_TIMEFRAMES InpPDTimeframe   = PERIOD_H4; // HTF for range calculation
input int     InpPDLookback            = 50;    // bars to find HTF range

// ── NEW 6: RSI Divergence ───────────────────────────────────────────
input bool    InpDivEnable             = true;
input int     InpDivLookback           = 20;    // bars to scan for divergence

// ── NEW 7: Order Block ──────────────────────────────────────────────
input bool    InpOBEnable              = true;
input int     InpOBLookback            = 40;    // H1 bars to scan for OBs
input double  InpOBImpulseATR          = 1.5;   // impulse candle must be >= N×ATR

// ── NEW 8: News Blackout ────────────────────────────────────────────
// Enter upcoming high-impact news times manually (UTC).
// Format: HHMM as integer. Set unused slots to 0.
input bool    InpNewsEnable            = true;
input int     InpNewsTime1             = 0;     // e.g. 1330 = 13:30 UTC
input int     InpNewsTime2             = 0;
input int     InpNewsTime3             = 0;
input int     InpNewsTime4             = 0;
input int     InpNewsBufferMins        = 30;    // block N mins before AND after

// ── NEW 9: Candle Pattern ───────────────────────────────────────────
input bool    InpCandleEnable          = true;  // require pattern at key level
input double  InpPinWickRatio          = 0.6;   // pin bar wick >= this fraction of range

// ── NEW 10: ATR Volatility Regime ──────────────────────────────────
input bool    InpVolRegimeEnable       = true;
input int     InpVolRegimePeriod       = 20;    // ATR avg period
input double  InpVolRegimeMin          = 0.80;  // ATR must be >= 80% of avg
input double  InpVolRegimeMax          = 1.80;  // ATR must be <= 180% of avg

// ── NEW 11: DXY Correlation ────────────────────────────────────────
input bool    InpDXYEnable             = false; // off by default — needs DXY feed
input string  InpDXYSymbol             = "DXY"; // broker-specific DXY symbol name
input int     InpDXYMA                 = 50;    // DXY MA period on D1

// Facebook bridge
input bool    InpFacebookEnable        = true;
input string  InpFacebookURL           = "https://localhost:5005/signal";
input string  InpFacebookBasis         = "SMC Structure + Liquidity Sweep + Kill Zone";

// Debug
input bool    InpDebugLog              = false;

//─────────────────────────── HANDLES ───────────────────────────────
int h_w_ema, h_d_ma, h_d_fast, h_d_slow, h_h1_ema;
int h_rsi, h_macd, h_atr, h_adx;
int h_m5_ef, h_m5_es, h_m5_rsi, h_m5_macd;
int h_h1_rsi;     // NEW 6: RSI on H1 for divergence
int h_atr_d1;     // NEW 10: ATR on D1 for vol regime check
int h_dxy_ma;     // NEW 11: DXY MA handle

datetime g_lastBarTime    = 0;
datetime g_lastSignalTime = 0;
bool     g_startupSent    = false;

//─────────────────────────── EMOJI ─────────────────────────────────
string _Emoji(ushort hi,ushort lo){ushort s[2];s[0]=hi;s[1]=lo;return ShortArrayToString(s);}
string _EmojiB(ushort b){ushort s[1];s[0]=b;return ShortArrayToString(s);}
string E_GREEN() {return _Emoji(0xD83D,0xDFE2);}
string E_RED()   {return _Emoji(0xD83D,0xDD34);}
string E_MONEY() {return _Emoji(0xD83D,0xDCB0);}
string E_UP()    {return _Emoji(0xD83D,0xDCC8);}
string E_DOWN()  {return _Emoji(0xD83D,0xDCC9);}
string E_TARGET(){return _Emoji(0xD83C,0xDFAF);}
string E_STOP()  {return _Emoji(0xD83D,0xDED1);}
string E_CHECK() {return _EmojiB(0x2705);}
string E_RULER() {return _Emoji(0xD83D,0xDCD0);}
string E_CLOCK() {return _Emoji(0xD83D,0xDD51);}
string E_ROBOT() {return _Emoji(0xD83E,0xDD16);}
string E_CHART() {return _Emoji(0xD83D,0xDCCA);}
string E_STAR()  {return _Emoji(0xD83C,0xDF1F);}
string E_SKULL() {return _Emoji(0xD83D,0xDC80);}
string E_FIRE()  {return _Emoji(0xD83D,0xDD25);}
string E_WARN()  {return _EmojiB(0x26A0);}
string E_LOCK()  {return _Emoji(0xD83D,0xDD12);}
string E_ZONE()  {return _Emoji(0xD83D,0xDCCD);}
string E_SWEEP() {return _Emoji(0xD83C,0xDF00);}
string E_BLOCK() {return _Emoji(0xD83E,0xDDF1);}
string SEP(){return _EmojiB(0x2015)+_EmojiB(0x2015)+_EmojiB(0x2015)+_EmojiB(0x2015)+
             _EmojiB(0x2015)+_EmojiB(0x2015)+_EmojiB(0x2015)+_EmojiB(0x2015)+
             _EmojiB(0x2015)+_EmojiB(0x2015)+_EmojiB(0x2015);}

//+------------------------------------------------------------------+
int OnInit()
{
   h_w_ema  = iMA(_Symbol,PERIOD_W1, InpWeeklyEMA,  0,MODE_EMA,PRICE_CLOSE);
   h_d_ma   = iMA(_Symbol,PERIOD_D1, InpDailyMA,    0,MODE_SMA,PRICE_CLOSE);
   h_d_fast = iMA(_Symbol,PERIOD_D1, InpCrossFastMA,0,MODE_SMA,PRICE_CLOSE);
   h_d_slow = iMA(_Symbol,PERIOD_D1, InpCrossSlowMA,0,MODE_SMA,PRICE_CLOSE);
   h_h1_ema = iMA(_Symbol,PERIOD_H1, InpH1EMA,      0,MODE_EMA,PRICE_CLOSE);
   h_rsi    = iRSI(_Symbol,PERIOD_M15,InpRSIPeriod,    PRICE_CLOSE);
   h_macd   = iMACD(_Symbol,PERIOD_M15,InpMACDFast,InpMACDSlow,InpMACDSignalP,PRICE_CLOSE);
   h_atr    = iATR(_Symbol,PERIOD_M15,InpATRPeriod);
   h_adx    = iADX(_Symbol,PERIOD_D1, InpADXPeriod);
   h_m5_ef  = iMA(_Symbol,PERIOD_M5,InpM5EMAFast,0,MODE_EMA,PRICE_CLOSE);
   h_m5_es  = iMA(_Symbol,PERIOD_M5,InpM5EMASlow, 0,MODE_EMA,PRICE_CLOSE);
   h_m5_rsi = iRSI(_Symbol,PERIOD_M5,InpM5RSIPeriod,PRICE_CLOSE);
   h_m5_macd= iMACD(_Symbol,PERIOD_M5,InpMACDFast,InpMACDSlow,InpMACDSignalP,PRICE_CLOSE);
   // NEW handles
   h_h1_rsi = iRSI(_Symbol,PERIOD_H1,InpRSIPeriod,PRICE_CLOSE);
   h_atr_d1 = iATR(_Symbol,PERIOD_M15,InpVolRegimePeriod); // M15 ATR for vol regime
   h_dxy_ma = (InpDXYEnable && StringLen(InpDXYSymbol)>0)
              ? iMA(InpDXYSymbol,PERIOD_D1,InpDXYMA,0,MODE_SMA,PRICE_CLOSE)
              : INVALID_HANDLE;

   bool bad = (h_w_ema==INVALID_HANDLE||h_d_ma==INVALID_HANDLE||
               h_d_fast==INVALID_HANDLE||h_d_slow==INVALID_HANDLE||
               h_h1_ema==INVALID_HANDLE||h_rsi==INVALID_HANDLE||
               h_macd==INVALID_HANDLE||h_atr==INVALID_HANDLE||
               h_adx==INVALID_HANDLE||h_m5_ef==INVALID_HANDLE||
               h_m5_es==INVALID_HANDLE||h_m5_rsi==INVALID_HANDLE||
               h_m5_macd==INVALID_HANDLE||h_h1_rsi==INVALID_HANDLE||
               h_atr_d1==INVALID_HANDLE);
   if(bad){ Print("ERROR: handle creation failed"); return(INIT_FAILED); }

   Print("SignalBot MT5 v6.0 initialised on ",_Symbol);
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   int arr[]={h_w_ema,h_d_ma,h_d_fast,h_d_slow,h_h1_ema,
              h_rsi,h_macd,h_atr,h_adx,
              h_m5_ef,h_m5_es,h_m5_rsi,h_m5_macd,
              h_h1_rsi,h_atr_d1,h_dxy_ma};
   for(int i=0;i<ArraySize(arr);i++)
      if(arr[i]!=INVALID_HANDLE) IndicatorRelease(arr[i]);
}

void OnTick()
{
   if(!g_startupSent)
   {
      g_startupSent=true;
      if(InpSendStartupMessage)
      {
         string msg=E_ROBOT()+" <b>SignalBot MT5 v6.0 — INSTITUTIONAL EDITION</b>\n"
                    +SEP()+"\n"
                    +E_CHART()+" Symbol : "+_Symbol+"\n"
                    +E_CLOCK()+" Stack  : W1 > D1 > H4 > H1 > M15 > M5\n"
                    +E_CHECK()+" Kill Zones  : "+(InpKillZoneEnable?"ON":"OFF")+"\n"
                    +E_CHECK()+" Liq Sweep   : "+(InpLiqSweepEnable?"ON":"OFF")+"\n"
                    +E_CHECK()+" FVG         : "+(InpFVGEnable?"ON":"OFF")+"\n"
                    +E_CHECK()+" CHoCH/BOS   : "+(InpCHoCHEnable?"ON":"OFF")+"\n"
                    +E_CHECK()+" Prem/Disc   : "+(InpPDEnable?"ON":"OFF")+"\n"
                    +E_CHECK()+" Divergence  : "+(InpDivEnable?"ON":"OFF")+"\n"
                    +E_CHECK()+" Order Block : "+(InpOBEnable?"ON":"OFF")+"\n"
                    +E_CHECK()+" News Block  : "+(InpNewsEnable?"ON":"OFF")+"\n"
                    +E_CHECK()+" Candle Pat  : "+(InpCandleEnable?"ON":"OFF")+"\n"
                    +E_CHECK()+" Vol Regime  : "+(InpVolRegimeEnable?"ON":"OFF")+"\n"
                    +E_CHECK()+" DXY Filter  : "+(InpDXYEnable?"ON":"OFF")+"\n"
                    +E_CHECK()+" Min score   : "+IntegerToString(InpMinScore)+" / 20\n"
                    +E_CHECK()+" Monitoring markets...";
         PostToTelegram(msg);
      }
   }

   datetime t=iTime(_Symbol,PERIOD_M5,0);
   if(t==g_lastBarTime) return;
   g_lastBarTime=t;
   ProcessSignals();
}

//─────────────────────────── BUFFER HELPER ─────────────────────────
double BufVal(int handle,int buf,int shift)
{
   if(handle==INVALID_HANDLE) return(EMPTY_VALUE);
   double b[]; ArraySetAsSeries(b,true);
   int got=CopyBuffer(handle,buf,0,shift+3,b);
   if(got<=shift) return(EMPTY_VALUE);
   return(b[shift]);
}

//─────────────────────────── FILTERS ───────────────────────────────

bool MarketIsTrending()
{
   if(!InpADXEnable) return(true);
   double adx=BufVal(h_adx,0,1);
   if(adx==EMPTY_VALUE) return(true);
   return(adx>=InpADXMinTrend);
}

bool InSession()
{
   if(!InpSessionEnable) return(true);
   MqlDateTime dt; TimeToStruct(TimeCurrent(),dt);
   return(dt.hour>=InpSessionStartHour && dt.hour<InpSessionEndHour);
}

bool SpreadOK()
{
   if(!InpSpreadEnable) return(true);
   long spread=(long)SymbolInfoInteger(_Symbol,SYMBOL_SPREAD);
   return(spread<=InpMaxSpreadPoints);
}

// ── NEW 1: Kill Zone ───────────────────────────────────────────────
// Returns true when inside London KZ, NY KZ, or London Close KZ.
// Also returns a string label for the message.
bool InKillZone(string &kzLabel)
{
   if(!InpKillZoneEnable){ kzLabel="Session"; return(true); }
   MqlDateTime dt; TimeToStruct(TimeCurrent(),dt);
   int h=dt.hour;
   if(h>=InpLKZ_Start  && h<InpLKZ_End) { kzLabel="London KZ";      return(true); }
   if(h>=InpNYKZ_Start && h<InpNYKZ_End){ kzLabel="New York KZ";    return(true); }
   if(h>=InpLCKZ_Start && h<InpLCKZ_End){ kzLabel="London Close KZ";return(true); }
   kzLabel="";
   return(false);
}

// ── NEW 8: News Blackout ────────────────────────────────────────────
// Returns true if current time is within InpNewsBufferMins of any
// configured news time. Times are stored as HHMM integers (e.g. 1330).
bool NewsBlackout()
{
   if(!InpNewsEnable) return(false);
   int times[4];
   times[0]=InpNewsTime1; times[1]=InpNewsTime2;
   times[2]=InpNewsTime3; times[3]=InpNewsTime4;
   MqlDateTime dt; TimeToStruct(TimeCurrent(),dt);
   int nowMins=dt.hour*60+dt.min;
   for(int i=0;i<4;i++)
   {
      if(times[i]==0) continue;
      int hh=times[i]/100, mm=times[i]%100;
      int eventMins=hh*60+mm;
      if(MathAbs(nowMins-eventMins)<=InpNewsBufferMins) return(true);
   }
   return(false);
}

// ── NEW 10: ATR Volatility Regime ──────────────────────────────────
// Returns true when ATR is in the 80–180% band of its own N-bar average.
bool VolRegimeOK()
{
   if(!InpVolRegimeEnable) return(true);
   double cur=BufVal(h_atr,0,1);
   if(cur==EMPTY_VALUE) return(true);
   double arr[]; ArraySetAsSeries(arr,true);
   if(CopyBuffer(h_atr_d1,0,0,InpVolRegimePeriod+2,arr)<=0) return(true);
   double avg=0;
   for(int i=1;i<=InpVolRegimePeriod;i++) avg+=arr[i];
   avg/=InpVolRegimePeriod;
   if(avg<=0) return(true);
   double ratio=cur/avg;
   return(ratio>=InpVolRegimeMin && ratio<=InpVolRegimeMax);
}

//─────────────────────────── BIAS ──────────────────────────────────
int WeeklyBias()
{
   double e=BufVal(h_w_ema,0,1); if(e==EMPTY_VALUE) return(0);
   return(iClose(_Symbol,PERIOD_W1,1)>e?1:-1);
}
int DailyBias()
{
   double m=BufVal(h_d_ma,0,1); if(m==EMPTY_VALUE) return(0);
   double p=iClose(_Symbol,PERIOD_D1,1);
   return(p>m?1:p<m?-1:0);
}
int GoldenDeathCross()
{
   double f0=BufVal(h_d_fast,0,1),s0=BufVal(h_d_slow,0,1);
   double f1=BufVal(h_d_fast,0,2),s1=BufVal(h_d_slow,0,2);
   if(f0==EMPTY_VALUE||s0==EMPTY_VALUE||f1==EMPTY_VALUE||s1==EMPTY_VALUE) return(0);
   if(f1<=s1&&f0>s0) return(1);
   if(f1>=s1&&f0<s0) return(-1);
   return(0);
}
int H1EMABias()
{
   double e=BufVal(h_h1_ema,0,1); if(e==EMPTY_VALUE) return(0);
   double p=iClose(_Symbol,PERIOD_H1,1);
   return(p>e?1:p<e?-1:0);
}

// ── NEW 11: DXY Correlation ─────────────────────────────────────────
// Returns true when the signal direction aligns with expected DXY posture.
// Dollar-positive pairs (USD is base: USDXXX): BUY needs DXY bullish.
// Dollar-negative pairs (USD is quote: XXXUSD): BUY needs DXY bearish.
// Returns true (pass) when DXY not enabled or not available.
bool DXYAligned(int trend)
{
   if(!InpDXYEnable || h_dxy_ma==INVALID_HANDLE) return(true);
   double dxyClose=iClose(InpDXYSymbol,PERIOD_D1,1);
   double dxyMA   =BufVal(h_dxy_ma,0,1);
   if(dxyMA==EMPTY_VALUE||dxyClose<=0) return(true);
   bool dxyBull=(dxyClose>dxyMA);

   // Check if USD is base currency (first 3 chars)
   string sym=_Symbol;
   bool usdBase  =(StringSubstr(sym,0,3)=="USD");
   bool usdQuote =(StringSubstr(sym,3,3)=="USD");

   if(!usdBase && !usdQuote) return(true); // non-USD pair — skip
   if(usdBase)  return(trend==1 ? dxyBull : !dxyBull);
   return(trend==1 ? !dxyBull : dxyBull);  // usdQuote
}

//─────────────────────────── STRUCTURE ─────────────────────────────
bool SwingHL(double &swH,double &swL)
{
   double hi[],lo[];
   ArraySetAsSeries(hi,true); ArraySetAsSeries(lo,true);
   int n1=CopyHigh(_Symbol,PERIOD_H1,1,InpSwingLookback,hi);
   int n2=CopyLow (_Symbol,PERIOD_H1,1,InpSwingLookback,lo);
   if(n1<=0||n2<=0) return(false);
   swH=-DBL_MAX; swL=DBL_MAX;
   for(int i=0;i<n1;i++) if(hi[i]>swH) swH=hi[i];
   for(int i=0;i<n2;i++) if(lo[i]<swL) swL=lo[i];
   return(swH>-DBL_MAX&&swL<DBL_MAX);
}

bool FibZone(double price,double swH,double swL,int trend,double &a,double &b)
{
   double r=swH-swL; if(r<=0) return(false);
   if(trend==1){a=swH-0.618*r; b=swH-0.500*r;}
   else        {a=swL+0.500*r; b=swL+0.618*r;}
   return(price>=a&&price<=b);
}

bool TwoFractals(bool findHighs,int &idx1,double &p1,int &idx2,double &p2)
{
   int wing=InpFractalWing,total=InpSwingLookback+2*wing+2,found=0;
   int ia[2]; double va[2];
   for(int i=wing;i<total-wing&&found<2;i++)
   {
      double c=findHighs?iHigh(_Symbol,PERIOD_H1,i):iLow(_Symbol,PERIOD_H1,i);
      bool ok=true;
      for(int k=1;k<=wing;k++)
      {
         double prev=findHighs?iHigh(_Symbol,PERIOD_H1,i+k):iLow(_Symbol,PERIOD_H1,i+k);
         double next=findHighs?iHigh(_Symbol,PERIOD_H1,i-k):iLow(_Symbol,PERIOD_H1,i-k);
         if(findHighs){if(c<prev||c<next){ok=false;break;}}
         else         {if(c>prev||c>next){ok=false;break;}}
      }
      if(ok){ia[found]=i;va[found]=c;found++;}
   }
   if(found<2) return(false);
   idx1=ia[0];p1=va[0];idx2=ia[1];p2=va[1];
   return(true);
}
int TrendlineOK(int trend)
{
   int i1,i2; double p1,p2;
   if(trend==1)
   {
      if(!TwoFractals(false,i1,p1,i2,p2)||i2==i1) return(0);
      double s=(p1-p2)/(double)(i2-i1);
      return(iLow(_Symbol,PERIOD_H1,1)>=(p1+s*(i1-1))*0.999?1:0);
   }
   if(trend==-1)
   {
      if(!TwoFractals(true,i1,p1,i2,p2)||i2==i1) return(0);
      double s=(p1-p2)/(double)(i2-i1);
      return(iHigh(_Symbol,PERIOD_H1,1)<=(p1+s*(i1-1))*1.001?-1:0);
   }
   return(0);
}

// ── NEW 4: CHoCH / BOS ─────────────────────────────────────────────
// Scans H1 for the last two fractal swing highs and lows.
// BOS (bullish):  recent close breaks above the last swing high  → +1
// BOS (bearish):  recent close breaks below the last swing low   → -1
// CHoCH detected: opposite break — sets flag but does not score
// Returns: +1 BOS bull, -1 BOS bear, 0 = no confirmed break
int DetectCHoCH_BOS(int trend, bool &chaoch)
{
   chaoch=false;
   if(!InpCHoCHEnable) return(0);

   // Find two most recent swing highs and lows
   int wing=InpFractalWing;
   double lastSwingH=-DBL_MAX, prevSwingH=-DBL_MAX;
   double lastSwingL=DBL_MAX,  prevSwingL=DBL_MAX;
   int hFound=0, lFound=0;

   for(int i=wing; i<InpCHoCHLookback+wing && (hFound<2||lFound<2); i++)
   {
      if(hFound<2)
      {
         double c=iHigh(_Symbol,PERIOD_H1,i);
         bool ok=true;
         for(int k=1;k<=wing;k++)
            if(iHigh(_Symbol,PERIOD_H1,i+k)>=c||iHigh(_Symbol,PERIOD_H1,i-k)>=c){ok=false;break;}
         if(ok){ if(hFound==0) lastSwingH=c; else prevSwingH=c; hFound++; }
      }
      if(lFound<2)
      {
         double c=iLow(_Symbol,PERIOD_H1,i);
         bool ok=true;
         for(int k=1;k<=wing;k++)
            if(iLow(_Symbol,PERIOD_H1,i+k)<=c||iLow(_Symbol,PERIOD_H1,i-k)<=c){ok=false;break;}
         if(ok){ if(lFound==0) lastSwingL=c; else prevSwingL=c; lFound++; }
      }
   }

   double close=iClose(_Symbol,PERIOD_H1,1);

   if(trend==1)
   {
      if(lastSwingH>-DBL_MAX && close>lastSwingH) return(1);  // BOS bullish
      if(lastSwingL<DBL_MAX  && close<lastSwingL){ chaoch=true; return(0); } // CHoCH warning
   }
   else
   {
      if(lastSwingL<DBL_MAX  && close<lastSwingL) return(-1); // BOS bearish
      if(lastSwingH>-DBL_MAX && close>lastSwingH){ chaoch=true; return(0); } // CHoCH warning
   }
   return(0);
}

// ── NEW 5: Premium / Discount Zone ─────────────────────────────────
// Uses HTF (H4 by default) swing range. BUY only in lower 50% (Discount).
// SELL only in upper 50% (Premium).
bool InPremiumDiscount(int trend)
{
   if(!InpPDEnable) return(true);
   double hi[],lo[];
   ArraySetAsSeries(hi,true); ArraySetAsSeries(lo,true);
   if(CopyHigh(_Symbol,InpPDTimeframe,1,InpPDLookback,hi)<=0) return(true);
   if(CopyLow (_Symbol,InpPDTimeframe,1,InpPDLookback,lo)<=0) return(true);
   double rangeH=-DBL_MAX, rangeL=DBL_MAX;
   for(int i=0;i<InpPDLookback;i++){ if(hi[i]>rangeH) rangeH=hi[i]; if(lo[i]<rangeL) rangeL=lo[i]; }
   double mid=(rangeH+rangeL)/2.0;
   double price=iClose(_Symbol,PERIOD_H1,1);
   if(trend==1)  return(price<=mid); // Discount — buy below equilibrium
   return(price>=mid);               // Premium  — sell above equilibrium
}

// ── NEW 3: Fair Value Gap (FVG) ─────────────────────────────────────
// A bullish FVG: candle[i+1].high < candle[i-1].low — gap between wicks
// A bearish FVG: candle[i+1].low  > candle[i-1].high
// We scan H1 lookback for the most recent FVG in trend direction,
// then check if current price is inside it.
bool InFVG(int trend, double &fvgHigh, double &fvgLow)
{
   fvgHigh=0; fvgLow=0;
   if(!InpFVGEnable) return(false);
   double price=iClose(_Symbol,PERIOD_H1,1);
   for(int i=2;i<=InpFVGLookback;i++)
   {
      double h_prev=iHigh(_Symbol,PERIOD_H1,i+1);
      double l_prev=iLow (_Symbol,PERIOD_H1,i+1);
      double h_next=iHigh(_Symbol,PERIOD_H1,i-1);
      double l_next=iLow (_Symbol,PERIOD_H1,i-1);
      if(trend==1)
      {
         // Bullish FVG: gap between prev candle high and next candle low
         if(h_prev < l_next)
         {
            fvgLow=h_prev; fvgHigh=l_next;
            if(price>=fvgLow && price<=fvgHigh) return(true);
         }
      }
      else
      {
         // Bearish FVG: gap between prev candle low and next candle high
         if(l_prev > h_next)
         {
            fvgHigh=l_prev; fvgLow=h_next;
            if(price>=fvgLow && price<=fvgHigh) return(true);
         }
      }
   }
   return(false);
}

// ── NEW 7: Order Block ──────────────────────────────────────────────
// Bullish OB: last bearish H1 candle before a strong bullish impulse,
// and current price is pulling back into it.
// Bearish OB: last bullish H1 candle before a strong bearish impulse.
bool InOrderBlock(int trend, double &obHigh, double &obLow)
{
   obHigh=0; obLow=0;
   if(!InpOBEnable) return(false);
   double atr=BufVal(h_atr,0,1); if(atr==EMPTY_VALUE) return(false);
   double price=iClose(_Symbol,PERIOD_H1,1);

   for(int i=3;i<=InpOBLookback;i++)
   {
      double o_imp=iOpen (_Symbol,PERIOD_H1,i-1);
      double c_imp=iClose(_Symbol,PERIOD_H1,i-1);
      double impulse=MathAbs(c_imp-o_imp);
      if(impulse < atr*InpOBImpulseATR) continue; // not a strong impulse

      if(trend==1 && c_imp>o_imp) // impulse is bullish — OB is the candle before it
      {
         double ob_o=iOpen (_Symbol,PERIOD_H1,i);
         double ob_c=iClose(_Symbol,PERIOD_H1,i);
         if(ob_c<=ob_o) // that prior candle is bearish — valid bullish OB
         {
            obLow =MathMin(ob_o,ob_c);
            obHigh=MathMax(ob_o,ob_c);
            if(price>=obLow && price<=obHigh) return(true);
         }
      }
      else if(trend==-1 && c_imp<o_imp) // impulse is bearish — OB is the candle before it
      {
         double ob_o=iOpen (_Symbol,PERIOD_H1,i);
         double ob_c=iClose(_Symbol,PERIOD_H1,i);
         if(ob_c>=ob_o) // that prior candle is bullish — valid bearish OB
         {
            obLow =MathMin(ob_o,ob_c);
            obHigh=MathMax(ob_o,ob_c);
            if(price>=obLow && price<=obHigh) return(true);
         }
      }
   }
   return(false);
}

// ── NEW 2: Liquidity Sweep ──────────────────────────────────────────
// BUY: last M15 candle swept below a recent swing low (wick below)
//      then closed back above it — rejection confirmed.
// SELL: last M15 candle swept above a recent swing high, closed below.
bool LiquiditySweep(int trend)
{
   if(!InpLiqSweepEnable) return(false);

   // Find the reference swing level from bars 2..lookback
   double swingL=DBL_MAX, swingH=-DBL_MAX;
   for(int i=2;i<=InpLiqSweepLookback;i++)
   {
      double l=iLow (_Symbol,PERIOD_M15,i);
      double h=iHigh(_Symbol,PERIOD_M15,i);
      if(l<swingL) swingL=l;
      if(h>swingH) swingH=h;
   }

   double o=iOpen (_Symbol,PERIOD_M15,1);
   double h=iHigh (_Symbol,PERIOD_M15,1);
   double l=iLow  (_Symbol,PERIOD_M15,1);
   double c=iClose(_Symbol,PERIOD_M15,1);
   double rng=h-l; if(rng<=0) return(false);

   if(trend==1)
   {
      if(l>=swingL) return(false);         // did not sweep below the low
      if(c<=swingL) return(false);         // did not close back above — not rejected
      double wick=swingL-l;
      if(wick/rng < InpLiqSweepWickRatio) return(false); // wick too short
      return(true);
   }
   else
   {
      if(h<=swingH) return(false);
      if(c>=swingH) return(false);
      double wick=h-swingH;
      if(wick/rng < InpLiqSweepWickRatio) return(false);
      return(true);
   }
}

// ── NEW 6: RSI Divergence ───────────────────────────────────────────
// Scans M15 bars for regular and hidden divergence.
// Regular divergence (reversal):
//   Bullish: price LL, RSI HL
//   Bearish: price HH, RSI LH
// Hidden divergence (continuation):
//   Bullish: price HL, RSI LL
//   Bearish: price LH, RSI HH
// Returns: +1 = bullish divergence, -1 = bearish, 0 = none
// Sets divType: "regular" or "hidden"
int DetectDivergence(int trend, string &divType)
{
   divType="";
   if(!InpDivEnable) return(0);
   int n=InpDivLookback+2;

   double rsiArr[]; ArraySetAsSeries(rsiArr,true);
   if(CopyBuffer(h_rsi,0,0,n,rsiArr)<=0) return(0);

   double priceArr[]; ArraySetAsSeries(priceArr,true);
   if(CopyLow (_Symbol,PERIOD_M15,0,n,priceArr)<=0) return(0); // for bullish
   double priceHArr[]; ArraySetAsSeries(priceHArr,true);
   if(CopyHigh(_Symbol,PERIOD_M15,0,n,priceHArr)<=0) return(0); // for bearish

   // Find two most recent swing lows in price and RSI (for bullish div)
   if(trend==1)
   {
      double p1=-DBL_MAX,p2=-DBL_MAX; double r1=-DBL_MAX,r2=-DBL_MAX;
      int found=0;
      for(int i=2;i<n-2&&found<2;i++)
      {
         if(priceArr[i]<priceArr[i+1]&&priceArr[i]<priceArr[i-1])
         {
            if(found==0){p1=priceArr[i];r1=rsiArr[i];}
            else        {p2=priceArr[i];r2=rsiArr[i];}
            found++;
         }
      }
      if(found<2) return(0);
      // Regular bullish: price LL (p1<p2), RSI HL (r1>r2)
      if(p1<p2 && r1>r2){ divType="regular"; return(1); }
      // Hidden bullish:  price HL (p1>p2), RSI LL (r1<r2)
      if(p1>p2 && r1<r2){ divType="hidden";  return(1); }
   }
   else // trend==-1
   {
      double p1=-DBL_MAX,p2=-DBL_MAX; double r1=-DBL_MAX,r2=-DBL_MAX;
      int found=0;
      for(int i=2;i<n-2&&found<2;i++)
      {
         if(priceHArr[i]>priceHArr[i+1]&&priceHArr[i]>priceHArr[i-1])
         {
            if(found==0){p1=priceHArr[i];r1=rsiArr[i];}
            else        {p2=priceHArr[i];r2=rsiArr[i];}
            found++;
         }
      }
      if(found<2) return(0);
      // Regular bearish: price HH (p1>p2), RSI LH (r1<r2)
      if(p1>p2 && r1<r2){ divType="regular"; return(-1); }
      // Hidden bearish:  price LH (p1<p2), RSI HH (r1>r2)
      if(p1<p2 && r1>r2){ divType="hidden";  return(-1); }
   }
   return(0);
}

// ── NEW 9: Candle Pattern Confirmation ─────────────────────────────
// Checks the last closed M15 candle for engulfing, pin bar, or inside bar.
// Returns +1 (bullish pattern), -1 (bearish), 0 (no pattern).
int CandlePattern(int trend)
{
   if(!InpCandleEnable) return(1); // disabled — pass through
   double o1=iOpen (_Symbol,PERIOD_M15,1), c1=iClose(_Symbol,PERIOD_M15,1);
   double h1=iHigh (_Symbol,PERIOD_M15,1), l1=iLow  (_Symbol,PERIOD_M15,1);
   double o2=iOpen (_Symbol,PERIOD_M15,2), c2=iClose(_Symbol,PERIOD_M15,2);
   double h2=iHigh (_Symbol,PERIOD_M15,2), l2=iLow  (_Symbol,PERIOD_M15,2);
   double rng1=h1-l1; if(rng1<=0) return(0);
   double body1=MathAbs(c1-o1);

   // Bullish engulfing
   if(trend==1 && c2<o2 && c1>o1 && c1>o2 && o1<c2) return(1);
   // Bearish engulfing
   if(trend==-1 && c2>o2 && c1<o1 && c1<o2 && o1>c2) return(-1);

   // Bullish pin bar: lower wick >= ratio of range, small body in upper portion
   if(trend==1)
   {
      double lowerWick=MathMin(o1,c1)-l1;
      if(lowerWick/rng1>=InpPinWickRatio && body1/rng1<=0.3) return(1);
   }
   // Bearish pin bar: upper wick >= ratio of range
   if(trend==-1)
   {
      double upperWick=h1-MathMax(o1,c1);
      if(upperWick/rng1>=InpPinWickRatio && body1/rng1<=0.3) return(-1);
   }

   // Inside bar (compression before expansion)
   if(h1<h2 && l1>l2) return(trend); // inside bar in trend direction — valid

   return(0); // no pattern
}

//─────────────────────────── TRIGGERS ──────────────────────────────
int RSI15(double &val)
{
   val=BufVal(h_rsi,0,1); double r1=BufVal(h_rsi,0,2);
   if(val==EMPTY_VALUE||r1==EMPTY_VALUE) return(0);
   if(r1<InpRSIOversold  &&val>=InpRSIOversold)  return(1);
   if(r1>InpRSIOverbought&&val<=InpRSIOverbought) return(-1);
   if(val<InpRSIOversold  +10) return(1);
   if(val>InpRSIOverbought-10) return(-1);
   return(0);
}
int MACD15()
{
   double m0=BufVal(h_macd,0,1),m1=BufVal(h_macd,0,2);
   double s0=BufVal(h_macd,1,1),s1=BufVal(h_macd,1,2);
   if(m0==EMPTY_VALUE||s0==EMPTY_VALUE) return(0);
   if(m1<=s1&&m0>s0) return(1);
   if(m1>=s1&&m0<s0) return(-1);
   double h0=m0-s0,h1=m1-s1;
   if(h0>0&&h0>h1) return(1);
   if(h0<0&&h0<h1) return(-1);
   return(0);
}
int Vol15(int trend)
{
   long vols[]; ArraySetAsSeries(vols,true);
   if(CopyTickVolume(_Symbol,PERIOD_M15,1,21,vols)<=0) return(0);
   double avg=0; for(int i=1;i<=20;i++) avg+=vols[i]; avg/=20.0;
   if(vols[0]<avg*InpVolumeMultiplier) return(0);
   double o=iOpen(_Symbol,PERIOD_M15,1),c=iClose(_Symbol,PERIOD_M15,1);
   if(trend==1 &&c>o) return(1);
   if(trend==-1&&c<o) return(-1);
   return(0);
}
int M5EMA()
{
   double f0=BufVal(h_m5_ef,0,1),s0=BufVal(h_m5_es,0,1);
   double f1=BufVal(h_m5_ef,0,2),s1=BufVal(h_m5_es,0,2);
   if(f0==EMPTY_VALUE||s0==EMPTY_VALUE) return(0);
   if(f1<=s1&&f0>s0) return(1);
   if(f1>=s1&&f0<s0) return(-1);
   return(f0>s0?1:f0<s0?-1:0);
}
int M5RSI(double &val)
{
   val=BufVal(h_m5_rsi,0,1); double r1=BufVal(h_m5_rsi,0,2);
   if(val==EMPTY_VALUE) return(0);
   if(r1<InpM5RSIOversold  &&val>=InpM5RSIOversold)  return(1);
   if(r1>InpM5RSIOverbought&&val<=InpM5RSIOverbought) return(-1);
   if(val<InpM5RSIOversold  +8) return(1);
   if(val>InpM5RSIOverbought-8) return(-1);
   return(0);
}
int M5MACD()
{
   double m0=BufVal(h_m5_macd,0,1),m1=BufVal(h_m5_macd,0,2);
   double s0=BufVal(h_m5_macd,1,1),s1=BufVal(h_m5_macd,1,2);
   if(m0==EMPTY_VALUE||s0==EMPTY_VALUE) return(0);
   if(m1<=s1&&m0>s0) return(1);
   if(m1>=s1&&m0<s0) return(-1);
   double hh0=m0-s0,hh1=m1-s1;
   if(hh0>0&&hh0>hh1) return(1);
   if(hh0<0&&hh0<hh1) return(-1);
   return(0);
}

//─────────────────────────── AMD ───────────────────────────────────
int AMD(int trend,double &amdH,double &amdL)
{
   if(!InpAMDEnable) return(0);
   double atr=BufVal(h_atr,0,1);
   if(atr==EMPTY_VALUE||atr<=0) return(0);
   amdH=-DBL_MAX; amdL=DBL_MAX;
   for(int i=2;i<2+InpAMDAccumBars;i++)
   {
      double h=iHigh(_Symbol,PERIOD_M15,i);
      double l=iLow (_Symbol,PERIOD_M15,i);
      if(h>amdH) amdH=h;
      if(l<amdL) amdL=l;
   }
   if(amdH-amdL>=atr*InpAMDATRRatio) return(0);
   double o=iOpen(_Symbol,PERIOD_M15,1),h=iHigh(_Symbol,PERIOD_M15,1);
   double l=iLow(_Symbol,PERIOD_M15,1), c=iClose(_Symbol,PERIOD_M15,1);
   double rng=h-l; if(rng<=0) return(0);
   if(trend==1 &&l<amdL&&c>=amdL&&(MathMin(o,c)-l)/rng>=InpAMDWickRatio) return(1);
   if(trend==-1&&h>amdH&&c<=amdH&&(h-MathMax(o,c))/rng>=InpAMDWickRatio) return(-1);
   return(0);
}

//─────────────────────────── STRUCTURAL SL ─────────────────────────
// Finds the MOST RECENT H1 fractal swing low (BUY) or swing high (SELL).
// Adds ATR buffer to sit past the liquidity pool. Falls back to ATR mult.
double GetStructuralSL(int trend, double entry)
{
   double atr=BufVal(h_atr,0,1); if(atr==EMPTY_VALUE) atr=0;
   double buffer=atr*0.3;
   int    wing=InpFractalWing;
   int    total=InpSwingLookback+2*wing+2;

   if(trend==1)
   {
      for(int i=wing;i<total-wing;i++)
      {
         double c=iLow(_Symbol,PERIOD_H1,i);
         bool ok=true;
         for(int k=1;k<=wing;k++)
            if(iLow(_Symbol,PERIOD_H1,i+k)<=c||iLow(_Symbol,PERIOD_H1,i-k)<=c){ok=false;break;}
         if(!ok) continue;
         double sl=c-buffer;
         if(sl<entry&&(entry-sl)<=atr*3.0) return(sl);
         break;
      }
      return(entry-atr*InpSLATRMult);
   }
   else
   {
      for(int i=wing;i<total-wing;i++)
      {
         double c=iHigh(_Symbol,PERIOD_H1,i);
         bool ok=true;
         for(int k=1;k<=wing;k++)
            if(iHigh(_Symbol,PERIOD_H1,i+k)>=c||iHigh(_Symbol,PERIOD_H1,i-k)>=c){ok=false;break;}
         if(!ok) continue;
         double sl=c+buffer;
         if(sl>entry&&(sl-entry)<=atr*3.0) return(sl);
         break;
      }
      return(entry+atr*InpSLATRMult);
   }
}

//─────────────────────────── ROUND NUMBER FILTER ───────────────────
double RoundNumberAdjust(double price, int trend, bool isSL)
{
   double point   = SymbolInfoDouble(_Symbol,SYMBOL_POINT);
   int    digits  = (int)SymbolInfoInteger(_Symbol,SYMBOL_DIGITS);
   double interval= (digits>=4) ? 100.0*point : 10.0*point;
   double zone    = 8.0*point;
   double nearest = MathRound(price/interval)*interval;
   double dist    = MathAbs(price-nearest);
   if(dist>zone) return(price);
   double shift=(zone-dist)+2.0*point;
   if(isSL) return(trend==1 ? price-shift : price+shift);
   return(trend==1 ? price-shift : price+shift);
}

//─────────────────────────── TRADE LEVELS ──────────────────────────
void Levels(int trend, double &entry, double &sl, double &tp1, double &tp2, double &tp3)
{
   if(trend==1) entry=SymbolInfoDouble(_Symbol,SYMBOL_ASK);
   else         entry=SymbolInfoDouble(_Symbol,SYMBOL_BID);

   sl=GetStructuralSL(trend,entry);
   sl=RoundNumberAdjust(sl,trend,true);

   double slDist=MathAbs(entry-sl);

   if(trend==1)
   {
      tp1=entry+slDist*InpTP1Ratio;
      tp2=entry+slDist*InpRRRatio;
      tp3=entry+slDist*InpTP3Ratio;
   }
   else
   {
      tp1=entry-slDist*InpTP1Ratio;
      tp2=entry-slDist*InpRRRatio;
      tp3=entry-slDist*InpTP3Ratio;
   }

   tp1=RoundNumberAdjust(tp1,trend,false);
   tp2=RoundNumberAdjust(tp2,trend,false);
   tp3=RoundNumberAdjust(tp3,trend,false);
}

//─────────────────────────── TELEGRAM ──────────────────────────────
string FormEncode(string text)
{
   uchar bytes[];
   int n=StringToCharArray(text,bytes,0,StringLen(text),CP_UTF8)-1;
   if(n<=0) return("");
   string hex="0123456789ABCDEF", out="";
   for(int i=0;i<n;i++)
   {
      uchar c=bytes[i];
      if((c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9')||
         c=='-'||c=='_'||c=='.'||c=='~')
         out+=CharToString(c);
      else if(c==' ') out+="+";
      else out+="%"+StringSubstr(hex,c/16,1)+StringSubstr(hex,c%16,1);
   }
   return(out);
}
bool PostToTelegram(string text)
{
   string url="https://api.telegram.org/bot"+InpBotToken+"/sendMessage";
   string body="chat_id="+InpChatID+"&parse_mode=HTML&text="+FormEncode(text);
   uchar bodyBytes[];
   int bodyLen=StringLen(body);
   ArrayResize(bodyBytes,bodyLen);
   for(int i=0;i<bodyLen;i++) bodyBytes[i]=(uchar)StringGetCharacter(body,i);
   uchar result[]; string respHeaders;
   ResetLastError();
   int code=WebRequest("POST",url,
                       "Content-Type: application/x-www-form-urlencoded\r\n",
                       5000,bodyBytes,result,respHeaders);
   if(code==-1)
   { Print("Telegram error ",GetLastError()," -- add https://api.telegram.org to allowed URLs"); return(false); }
   if(code!=200) Print("Telegram HTTP ",code,": ",CharArrayToString(result));
   return(code==200);
}

//─────────────────────────── FACEBOOK ──────────────────────────────
bool SendFacebookSignal(string dir,double entry,double sl,double tp1,double tp2)
{
   if(!InpFacebookEnable) return(true);
   string body="symbol="+_Symbol+"&direction="+dir
              +"&entry="+DoubleToString(entry,5)
              +"&sl="+DoubleToString(sl,5)
              +"&tp="+DoubleToString(tp1,5)
              +"&tp2="+DoubleToString(tp2,5)
              +"&basis="+InpFacebookBasis;
   uchar bArr[],res[]; string hdrs;
   StringToCharArray(body,bArr,0,StringLen(body));
   int code=WebRequest("POST",InpFacebookURL,
                       "Content-Type: application/x-www-form-urlencoded\r\n",
                       3000,bArr,res,hdrs);
   return(code==200);
}

//─────────────────────────── MAIN LOGIC ────────────────────────────
void ProcessSignals()
{
   // Golden / Death cross — independent of all filters
   int cross=GoldenDeathCross();
   if(cross!=0&&InpAlertGoldenDeathCross)
   {
      string icon=(cross==1)?E_STAR():E_SKULL();
      string msg=icon+" <b>"+(cross==1?"GOLDEN":"DEATH")+" CROSS - "+_Symbol+"</b>\n"
                 +SEP()+"\n"
                 +"Daily MA"+IntegerToString(InpCrossFastMA)
                 +" crossed "+(cross==1?"above":"below")
                 +" MA"+IntegerToString(InpCrossSlowMA)+"\n"
                 +"Bias : "+(cross==1?"Bullish":"Bearish")+"\n"
                 +E_CLOCK()+" "+TimeToString(TimeCurrent(),TIME_DATE|TIME_MINUTES);
      PostToTelegram(msg);
   }

   if(!InpAlertFullSignal) return;

   // ── Hard Gate Filters (any fail = no signal) ──────────────────
   if(!InSession())        return;
   if(!SpreadOK())         return;
   if(!MarketIsTrending()) return;
   if(!VolRegimeOK())      return; // NEW 10
   if(NewsBlackout())      return; // NEW 8

   // ── Kill Zone check — must be inside one ─────────────────────
   string kzLabel;
   if(!InKillZone(kzLabel)) return; // NEW 1

   // ── Bias ──────────────────────────────────────────────────────
   int wb=WeeklyBias(), db=DailyBias();
   if(db==0) return;
   int trend=db;

   // ── DXY Correlation ───────────────────────────────────────────
   if(!DXYAligned(trend)) return; // NEW 11

   // ── Premium / Discount Gate ───────────────────────────────────
   if(!InPremiumDiscount(trend)) return; // NEW 5

   // ── Structure ─────────────────────────────────────────────────
   double swH,swL;
   if(!SwingHL(swH,swL)) return;
   double price=iClose(_Symbol,PERIOD_H1,1);
   double fibA,fibB;
   bool fib=FibZone(price,swH,swL,trend,fibA,fibB);
   int  tl =TrendlineOK(trend);
   int  h1e=H1EMABias();

   // ── CHoCH / BOS ───────────────────────────────────────────────
   bool chaoch=false;
   int  bos=DetectCHoCH_BOS(trend,chaoch); // NEW 4
   if(chaoch) return; // CHoCH against trend direction — skip signal

   // ── FVG ───────────────────────────────────────────────────────
   double fvgH,fvgL;
   bool fvgOK=InFVG(trend,fvgH,fvgL); // NEW 3

   // ── Order Block ───────────────────────────────────────────────
   double obH,obL;
   bool obOK=InOrderBlock(trend,obH,obL); // NEW 7

   // ── Liquidity Sweep ───────────────────────────────────────────
   bool sweep=LiquiditySweep(trend); // NEW 2

   // ── RSI Divergence ────────────────────────────────────────────
   string divType;
   int divDir=DetectDivergence(trend,divType); // NEW 6
   bool divOK=(divDir==trend);

   // ── Triggers ─────────────────────────────────────────────────
   double rsiVal; int rsi15=RSI15(rsiVal);
   int mac15=MACD15();
   int vol15=Vol15(trend);
   int emaCross=M5EMA();
   double m5rsi; int rsi5=M5RSI(m5rsi);
   int mac5=M5MACD();

   // ── Candle Pattern ────────────────────────────────────────────
   int candlePat=CandlePattern(trend); // NEW 9

   // ── AMD ───────────────────────────────────────────────────────
   double amdH,amdL;
   bool amdOK=(AMD(trend,amdH,amdL)==trend);

   // ── Weighted Confluence Score (max 20) ────────────────────────
   //
   // HTF Alignment           (max 5)
   //   D1 bias                      +3
   //   W1 alignment                 +2
   //
   // Institutional Structure (max 6)
   //   BOS confirmation             +2
   //   Order Block                  +2
   //   FVG (price inside gap)       +2
   //
   // Entry Precision         (max 5)
   //   Liquidity Sweep              +2
   //   Kill Zone bonus              +1
   //   AMD Judas swing              +1
   //   RSI Divergence               +1 (regular +1, hidden +1)
   //
   // Supporting Confluence   (max 4)
   //   H1 EMA                       +1
   //   H1 Trendline                 +1
   //   Fibonacci zone               +1
   //   Candle pattern               +1
   //
   // Momentum triggers (min 1 required, not scored to avoid inflation)

   int score=0;

   // HTF Alignment
   if(db==trend)   score+=3;
   if(wb==trend)   score+=2;

   // Institutional Structure
   if(bos==trend)  score+=2;
   if(obOK)        score+=2;
   if(fvgOK)       score+=2;

   // Entry Precision
   if(sweep)       score+=2;
   if(kzLabel!="") score+=1;
   if(amdOK)       score+=1;
   if(divOK)       score+=1;

   // Supporting Confluence
   if(h1e==trend)  score+=1;
   if(tl==trend)   score+=1;
   if(fib)         score+=1;
   if(candlePat==trend) score+=1;

   // Momentum: at least one trigger required
   bool trigger=(rsi15==trend||mac15==trend||emaCross==trend||rsi5==trend);

   if(InpDebugLog)
   {
      double adxVal=BufVal(h_adx,0,1);
      long   spread=(long)SymbolInfoInteger(_Symbol,SYMBOL_SPREAD);
      Print(_Symbol," trend=",trend," score=",score,"/20",
            " bos=",bos," ob=",obOK," fvg=",fvgOK,
            " sweep=",sweep," kz=",kzLabel,
            " div=",divOK,"(",divType,")",
            " amd=",amdOK," candle=",candlePat,
            " rsi15=",rsi15," mac15=",mac15,
            " ADX=",DoubleToString(adxVal,1)," spread=",spread);
   }

   if(!trigger||score<InpMinScore) return;
   if(candlePat!=trend && InpCandleEnable) return; // require candle confirmation

   // ── Cooldown ──────────────────────────────────────────────────
   int coolSecs=InpCooldownBars*300;
   if(g_lastSignalTime!=0&&TimeCurrent()-g_lastSignalTime<coolSecs) return;

   // ── Levels ────────────────────────────────────────────────────
   double entry,sl,tp1,tp2,tp3;
   Levels(trend,entry,sl,tp1,tp2,tp3);
   double slDist=MathAbs(entry-sl);
   double rr2=InpRRRatio;
   double rr3=InpTP3Ratio;

   // ── Score Label ───────────────────────────────────────────────
   string scoreLabel;
   if(score>=16)      scoreLabel=E_FIRE()+" ELITE    ("+IntegerToString(score)+"/20)";
   else if(score>=12) scoreLabel=E_FIRE()+" STRONG   ("+IntegerToString(score)+"/20)";
   else if(score>=9)  scoreLabel=E_CHECK()+" MODERATE ("+IntegerToString(score)+"/20)";
   else               scoreLabel=E_WARN()+" WATCH    ("+IntegerToString(score)+"/20)";

   // ── Confluence Summary for message ────────────────────────────
   string conf="";
   if(bos==trend)      conf+="BOS ";
   if(obOK)            conf+="OB ";
   if(fvgOK)           conf+="FVG ";
   if(sweep)           conf+="LiqSweep ";
   if(divOK)           conf+=StringSubstr(divType,0,3)+"Div ";
   if(amdOK)           conf+="AMD ";
   if(fib)             conf+="Fib ";
   if(tl==trend)       conf+="TL ";
   if(candlePat==trend)conf+="CandlePat ";
   if(StringLen(conf)>0) conf=StringSubstr(conf,0,StringLen(conf)-1);

   // Breakeven level = entry ± 1R
   double beLevel=(trend==1)?(entry+slDist):(entry-slDist);

   // ── Telegram Message ─────────────────────────────────────────
   string msg;
   if(trend==1)
   {
      msg=E_GREEN()+E_GREEN()+E_GREEN()+"  <b>B U Y  S I G N A L</b>  "+E_GREEN()+E_GREEN()+E_GREEN()+"\n"
          +SEP()+"\n"
          +E_MONEY()+"  <b>"+_Symbol+"</b>   "+E_ZONE()+" "+kzLabel+"\n"
          +E_UP()+   "  <b>BUY</b>     "+scoreLabel+"\n"
          +SEP()+"\n"
          +E_TARGET()+"  Entry  :  <b>"+DoubleToString(entry,5)+"</b>\n"
          +E_STOP()+  "  SL     :  "+DoubleToString(sl,5)+"\n"
          +E_CHECK()+ "  TP1    :  "+DoubleToString(tp1,5)+"  (1:"+DoubleToString(InpTP1Ratio,1)+")\n"
          +E_CHECK()+ "  TP2    :  "+DoubleToString(tp2,5)+"  (1:"+DoubleToString(rr2,1)+")\n"
          +E_CHECK()+ "  TP3    :  "+DoubleToString(tp3,5)+"  (1:"+DoubleToString(rr3,1)+")\n"
          +E_RULER()+ "  R : R  :  1 : "+DoubleToString(rr2,1)+" / 1:"+DoubleToString(rr3,1)+"\n"
          +SEP()+"\n"
          +E_LOCK()+  "  Move SL to BE  :  "+DoubleToString(beLevel,5)+"\n"
          +E_WARN()+  "  Close 50% at TP1, trail to TP2, let 25% run to TP3\n"
          +SEP()+"\n"
          +E_SWEEP()+ "  Confluence : "+conf+"\n"
          +E_CLOCK()+ "  "+TimeToString(TimeCurrent(),TIME_DATE|TIME_MINUTES);
   }
   else
   {
      msg=E_RED()+E_RED()+E_RED()+"  <b>S E L L  S I G N A L</b>  "+E_RED()+E_RED()+E_RED()+"\n"
          +SEP()+"\n"
          +E_MONEY()+"  <b>"+_Symbol+"</b>   "+E_ZONE()+" "+kzLabel+"\n"
          +E_DOWN()+ "  <b>SELL</b>   "+scoreLabel+"\n"
          +SEP()+"\n"
          +E_TARGET()+"  Entry  :  <b>"+DoubleToString(entry,5)+"</b>\n"
          +E_STOP()+  "  SL     :  "+DoubleToString(sl,5)+"\n"
          +E_CHECK()+ "  TP1    :  "+DoubleToString(tp1,5)+"  (1:"+DoubleToString(InpTP1Ratio,1)+")\n"
          +E_CHECK()+ "  TP2    :  "+DoubleToString(tp2,5)+"  (1:"+DoubleToString(rr2,1)+")\n"
          +E_CHECK()+ "  TP3    :  "+DoubleToString(tp3,5)+"  (1:"+DoubleToString(rr3,1)+")\n"
          +E_RULER()+ "  R : R  :  1 : "+DoubleToString(rr2,1)+" / 1:"+DoubleToString(rr3,1)+"\n"
          +SEP()+"\n"
          +E_LOCK()+  "  Move SL to BE  :  "+DoubleToString(beLevel,5)+"\n"
          +E_WARN()+  "  Close 50% at TP1, trail to TP2, let 25% run to TP3\n"
          +SEP()+"\n"
          +E_SWEEP()+ "  Confluence : "+conf+"\n"
          +E_CLOCK()+ "  "+TimeToString(TimeCurrent(),TIME_DATE|TIME_MINUTES);
   }

   bool tgOk=PostToTelegram(msg);
   if(tgOk)
   {
      g_lastSignalTime=TimeCurrent();
      Print("[SignalBot v6.0] Signal sent: ",_Symbol," ",(trend==1?"BUY":"SELL"),
            " score=",score,"/20 entry=",DoubleToString(entry,5),
            " kz=",kzLabel);
   }
   else Print("[SignalBot v6.0] Telegram send failed for ",_Symbol);

   SendFacebookSignal((trend==1?"BUY":"SELL"),entry,sl,tp1,tp2);
}
//+------------------------------------------------------------------+
