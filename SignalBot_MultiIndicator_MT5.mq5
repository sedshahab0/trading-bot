//+------------------------------------------------------------------+
//|              SignalBot_MultiIndicator_MT5.mq5  v4.1              |
//|  Direct MT5 translation of the working MT4 v4.1 bot             |
//|  Same logic, same gates, same confluence rules                   |
//|                                                                  |
//|  SETUP                                                           |
//|   Tools > Options > Expert Advisors > Allow WebRequest          |
//|   Add: https://api.telegram.org                                 |
//+------------------------------------------------------------------+
#property copyright "SignalBot v4.1"
#property version   "4.10"
#property strict

//--- Inputs (identical to MT4)
input string  InpBotToken              = "PUT_YOUR_BOT_TOKEN_HERE";
input string  InpChatID                = "PUT_YOUR_CHAT_ID_HERE";
input bool    InpSendStartupMessage    = true;

input int     InpWeeklyEMA             = 21;
input int     InpDailyMA               = 200;
input int     InpCrossFastMA           = 50;
input int     InpCrossSlowMA           = 200;
input bool    InpAlertGoldenDeathCross = true;

input int     InpH1EMA                 = 50;
input int     InpSwingLookback         = 60;
input int     InpFractalWing           = 2;

input int     InpRSIPeriod             = 14;
input int     InpRSIOversold           = 32;
input int     InpRSIOverbought         = 68;
input int     InpMACDFast              = 12;
input int     InpMACDSlow              = 26;
input int     InpMACDSignalP           = 9;
input double  InpVolumeMultiplier      = 1.4;

input int     InpM5EMAFast             = 8;
input int     InpM5EMASlow             = 21;
input int     InpM5RSIPeriod           = 9;
input int     InpM5RSIOversold         = 35;
input int     InpM5RSIOverbought       = 65;

input int     InpATRPeriod             = 14;
input double  InpSLATRMult             = 1.2;
input double  InpRRRatio               = 2.0;

input int     InpMinConfluence         = 2;
input bool    InpAlertFullSignal       = true;
input int     InpCooldownBars          = 2;
input bool    InpShowWatchSignals      = true;

input bool    InpAMDEnable             = true;
input int     InpAMDAccumBars          = 20;
input double  InpAMDATRRatio           = 0.6;
input double  InpAMDWickRatio          = 0.6;

input bool    InpDebugLog              = false;  // print bias/trigger values to Experts log

//--- Globals
datetime g_lastBarTime    = 0;
datetime g_lastSignalTime = 0;

//--- Indicator handles (MT5 requires these; MT4 does not)
int h_w_ema, h_d_ma, h_d_fast, h_d_slow, h_h1_ema;
int h_rsi, h_macd, h_atr;
int h_m5_ef, h_m5_es, h_m5_rsi, h_m5_macd;

//--- Emoji: built at runtime via surrogate pairs (MT5 strings are UTF-16)
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
string SEP(){return _EmojiB(0x2015)+_EmojiB(0x2015)+_EmojiB(0x2015)+_EmojiB(0x2015)+
             _EmojiB(0x2015)+_EmojiB(0x2015)+_EmojiB(0x2015)+_EmojiB(0x2015)+
             _EmojiB(0x2015)+_EmojiB(0x2015)+_EmojiB(0x2015);}

//+------------------------------------------------------------------+
int OnInit()
{
   //--- Create indicator handles (MT5 requirement)
   h_w_ema  = iMA(_Symbol,PERIOD_W1, InpWeeklyEMA,  0,MODE_EMA,PRICE_CLOSE);
   h_d_ma   = iMA(_Symbol,PERIOD_D1, InpDailyMA,    0,MODE_SMA,PRICE_CLOSE);
   h_d_fast = iMA(_Symbol,PERIOD_D1, InpCrossFastMA,0,MODE_SMA,PRICE_CLOSE);
   h_d_slow = iMA(_Symbol,PERIOD_D1, InpCrossSlowMA,0,MODE_SMA,PRICE_CLOSE);
   h_h1_ema = iMA(_Symbol,PERIOD_H1, InpH1EMA,      0,MODE_EMA,PRICE_CLOSE);
   h_rsi    = iRSI(_Symbol, PERIOD_M15,InpRSIPeriod,   PRICE_CLOSE);
   h_macd   = iMACD(_Symbol,PERIOD_M15,InpMACDFast,InpMACDSlow,InpMACDSignalP,PRICE_CLOSE);
   h_atr    = iATR(_Symbol, PERIOD_M15,InpATRPeriod);
   h_m5_ef  = iMA(_Symbol,PERIOD_M5,InpM5EMAFast,0,MODE_EMA,PRICE_CLOSE);
   h_m5_es  = iMA(_Symbol,PERIOD_M5,InpM5EMASlow, 0,MODE_EMA,PRICE_CLOSE);
   h_m5_rsi = iRSI(_Symbol, PERIOD_M5,InpM5RSIPeriod,PRICE_CLOSE);
   h_m5_macd= iMACD(_Symbol,PERIOD_M5,InpMACDFast,InpMACDSlow,InpMACDSignalP,PRICE_CLOSE);

   if(h_w_ema==INVALID_HANDLE||h_d_ma==INVALID_HANDLE||h_d_fast==INVALID_HANDLE||
      h_d_slow==INVALID_HANDLE||h_h1_ema==INVALID_HANDLE||h_rsi==INVALID_HANDLE||
      h_macd==INVALID_HANDLE||h_atr==INVALID_HANDLE||h_m5_ef==INVALID_HANDLE||
      h_m5_es==INVALID_HANDLE||h_m5_rsi==INVALID_HANDLE||h_m5_macd==INVALID_HANDLE)
   { Print("ERROR: handle creation failed"); return(INIT_FAILED); }

   //--- Force MT5 to calculate all indicator buffers immediately
   //    (new handles return no data until the terminal has computed them)
   double warm[];
   ArraySetAsSeries(warm,true);
   for(int w=0;w<20;w++)
   {
      bool ready =
         CopyBuffer(h_w_ema,0,0,3,warm)>0   && CopyBuffer(h_d_ma,0,0,3,warm)>0   &&
         CopyBuffer(h_d_fast,0,0,3,warm)>0  && CopyBuffer(h_d_slow,0,0,3,warm)>0 &&
         CopyBuffer(h_h1_ema,0,0,3,warm)>0  && CopyBuffer(h_rsi,0,0,3,warm)>0    &&
         CopyBuffer(h_macd,0,0,3,warm)>0    && CopyBuffer(h_atr,0,0,3,warm)>0    &&
         CopyBuffer(h_m5_ef,0,0,3,warm)>0   && CopyBuffer(h_m5_es,0,0,3,warm)>0  &&
         CopyBuffer(h_m5_rsi,0,0,3,warm)>0  && CopyBuffer(h_m5_macd,0,0,3,warm)>0;
      if(ready) break;
      Sleep(100);
   }

   if(InpSendStartupMessage)
   {
      string msg = E_ROBOT()+" <b>SignalBot MT5 v4.1 - Online</b>\n"
                   +SEP()+"\n"
                   +E_CHART()+" Symbol : "+_Symbol+"\n"
                   +E_CLOCK()+" Stack  : W1 > D1 > H1 > M15 > M5\n"
                   +E_CHECK()+" Monitoring markets...";
      PostToTelegram(msg);
   }
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   int arr[]={h_w_ema,h_d_ma,h_d_fast,h_d_slow,h_h1_ema,
              h_rsi,h_macd,h_atr,h_m5_ef,h_m5_es,h_m5_rsi,h_m5_macd};
   for(int i=0;i<ArraySize(arr);i++) IndicatorRelease(arr[i]);
}

void OnTick()
{
   datetime t=iTime(_Symbol,PERIOD_M5,0);
   if(t==g_lastBarTime) return;
   g_lastBarTime=t;
   ProcessSignals();
}

//--- MT5 helper: read one buffer value, resilient to buffers not yet fully calculated
double BufVal(int handle,int buf,int shift)
{
   if(handle==INVALID_HANDLE) return(EMPTY_VALUE);
   double b[];
   ArraySetAsSeries(b,true);
   // Request a small extra window; some MT5 builds need >1 bar before
   // CopyBuffer returns data for newly created handles / thin symbols
   int got=CopyBuffer(handle,buf,0,shift+3,b);
   if(got<=shift) return(EMPTY_VALUE);
   return(b[shift]);
}

//--- Bias — identical logic to MT4, BufVal replaces iMA(...,shift)
int WeeklyBias()
{
   double e=BufVal(h_w_ema,0,1); if(e==EMPTY_VALUE) return(0);
   double p=iClose(_Symbol,PERIOD_W1,1);
   return(p>e?1:p<e?-1:0);
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

//--- Swing high/low — same as MT4, hardened against thin history
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

//--- Fibonacci — same as MT4
bool FibZone(double price,double swH,double swL,int trend,double &a,double &b)
{
   double r=swH-swL; if(r<=0) return(false);
   if(trend==1){a=swH-0.618*r; b=swH-0.500*r;}
   else        {a=swL+0.500*r; b=swL+0.618*r;}
   return(price>=a&&price<=b);
}

//--- Fractal trendline — same as MT4
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

//--- M15 triggers — same logic as MT4, BufVal replaces iRSI/iMACD with shift
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

//--- M5 scalp — same logic as MT4
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
   double h0=m0-s0,h1=m1-s1;
   if(h0>0&&h0>h1) return(1);
   if(h0<0&&h0<h1) return(-1);
   return(0);
}

//--- AMD — same as MT4, iATR/iHigh/iLow/etc work the same in MT5
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

//--- Trade levels
void Levels(int trend,double &entry,double &sl,double &tp)
{
   double atr=BufVal(h_atr,0,1); if(atr==EMPTY_VALUE) atr=0;
   if(trend==1)
   { entry=SymbolInfoDouble(_Symbol,SYMBOL_ASK); sl=entry-atr*InpSLATRMult; tp=entry+(entry-sl)*InpRRRatio; }
   else
   { entry=SymbolInfoDouble(_Symbol,SYMBOL_BID); sl=entry+atr*InpSLATRMult; tp=entry-(sl-entry)*InpRRRatio; }
}

//--- Telegram POST (same as MT4, CharToString instead of CharToStr)
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
   string url ="https://api.telegram.org/bot"+InpBotToken+"/sendMessage";

   // FormEncode only the message text, then assemble body as plain ASCII
   string body="chat_id="+InpChatID+"&parse_mode=HTML&text="+FormEncode(text);

   // body is now all ASCII-safe; convert directly with no codepage conversion
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
void ProcessSignals()
{
   int cross=GoldenDeathCross();
   if(cross!=0&&InpAlertGoldenDeathCross)
   {
      string icon=(cross==1)?E_STAR():E_SKULL();
      string msg = icon+" <b>"+(cross==1?"GOLDEN":"DEATH")+" CROSS - "+_Symbol+"</b>\n"
                   +SEP()+"\n"
                   +"Daily MA"+IntegerToString(InpCrossFastMA)
                   +" crossed "+(cross==1?"above":"below")
                   +" MA"+IntegerToString(InpCrossSlowMA)+"\n"
                   +"Bias : "+(cross==1?"Bullish":"Bearish")+"\n"
                   +E_CLOCK()+" "+TimeToString(TimeCurrent(),TIME_DATE|TIME_MINUTES);
      PostToTelegram(msg);
   }

   if(!InpAlertFullSignal) return;

   // Daily bias sets direction. Weekly bias adds confluence but is NOT a hard gate.
   int wb=WeeklyBias(), db=DailyBias();
   if(db==0) return;
   int trend=db;

   double swH,swL;
   if(!SwingHL(swH,swL)) return;
   double price=iClose(_Symbol,PERIOD_H1,1);
   double fibA,fibB;
   bool   fib=FibZone(price,swH,swL,trend,fibA,fibB);
   int    tl =TrendlineOK(trend);
   int    h1e=H1EMABias();
   // h1e is a confluence factor only (not a hard gate)

   double rsiVal; int rsi15=RSI15(rsiVal);
   int mac15=MACD15();
   int vol15=Vol15(trend);

   int    emaCross=M5EMA();
   double m5rsi;  int rsi5=M5RSI(m5rsi);
   int    mac5=M5MACD();

   double amdH,amdL;
   bool amdOK=(AMD(trend,amdH,amdL)==trend);

   int conf=0;
   if(wb==trend)       conf++;
   if(h1e==trend)      conf++;
   if(fib)             conf++;
   if(tl==trend)       conf++;
   if(rsi15==trend)    conf++;
   if(mac15==trend)    conf++;
   if(vol15==trend)    conf++;
   if(emaCross==trend) conf++;
   if(rsi5==trend)     conf++;
   if(amdOK)           conf++;

   bool trigger=(rsi15==trend||mac15==trend||emaCross==trend||rsi5==trend);

   if(InpDebugLog)
      Print(_Symbol," trend=",trend," wb=",wb," db=",db," h1e=",h1e,
            " rsi15=",rsi15," mac15=",mac15," vol15=",vol15,
            " emaCross=",emaCross," rsi5=",rsi5," amdOK=",amdOK,
            " conf=",conf," trigger=",trigger);

   if(!trigger||conf<InpMinConfluence) return;
   if(!InpShowWatchSignals&&conf<4) return;

   int coolSecs=InpCooldownBars*300;
   if(g_lastSignalTime!=0&&TimeCurrent()-g_lastSignalTime<coolSecs) return;

   double entry,sl,tp;
   Levels(trend,entry,sl,tp);

   string msg;
   if(trend==1)
   {
      msg = E_GREEN()+E_GREEN()+E_GREEN()+"  <b>B U Y  S I G N A L</b>  "+E_GREEN()+E_GREEN()+E_GREEN()+"\n"
            +SEP()+"\n"
            +E_MONEY()+"  <b>"+_Symbol+"</b>\n"
            +E_UP()+   "  <b>BUY</b>\n"
            +SEP()+"\n"
            +E_TARGET()+"  Entry  :  <b>"+DoubleToString(entry,5)+"</b>\n"
            +E_STOP()+  "  SL     :  "+DoubleToString(sl,5)+"\n"
            +E_CHECK()+ "  TP     :  "+DoubleToString(tp,5)+"\n"
            +E_RULER()+ "  R : R  :  1 : "+DoubleToString(InpRRRatio,1)+"\n"
            +SEP()+"\n"
            +E_CLOCK()+ "  "+TimeToString(TimeCurrent(),TIME_DATE|TIME_MINUTES);
   }
   else
   {
      msg = E_RED()+E_RED()+E_RED()+"  <b>S E L L  S I G N A L</b>  "+E_RED()+E_RED()+E_RED()+"\n"
            +SEP()+"\n"
            +E_MONEY()+"  <b>"+_Symbol+"</b>\n"
            +E_DOWN()+  "  <b>SELL</b>\n"
            +SEP()+"\n"
            +E_TARGET()+"  Entry  :  <b>"+DoubleToString(entry,5)+"</b>\n"
            +E_STOP()+  "  SL     :  "+DoubleToString(sl,5)+"\n"
            +E_CHECK()+ "  TP     :  "+DoubleToString(tp,5)+"\n"
            +E_RULER()+ "  R : R  :  1 : "+DoubleToString(InpRRRatio,1)+"\n"
            +SEP()+"\n"
            +E_CLOCK()+ "  "+TimeToString(TimeCurrent(),TIME_DATE|TIME_MINUTES);
   }

   if(PostToTelegram(msg)) g_lastSignalTime=TimeCurrent();
}
//+------------------------------------------------------------------+
