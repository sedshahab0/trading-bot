//+------------------------------------------------------------------+
//|  FacebookSignalBridge.mq5                                        |
//|  Sends signal details to signal_server.py on your PC            |
//|  so Script 2 posts it to Facebook groups automatically.         |
//|                                                                  |
//|  HOW TO USE:                                                     |
//|  1. Add http://localhost:5005 to MT5 allowed URLs:              |
//|     Tools → Options → Expert Advisors → Allow WebRequest        |
//|  2. Call SendFacebookSignal() from your existing EA             |
//|     wherever you currently send the Telegram signal.            |
//+------------------------------------------------------------------+

#property copyright "BULL EYE TRADERS"
#property version   "1.00"

//--- Server settings
input string ServerURL  = "http://localhost:5005/signal";  // Signal server URL
input int    Timeout    = 5000;                            // ms

//+------------------------------------------------------------------+
//|  Main function — call this from your EA when a signal fires     |
//+------------------------------------------------------------------+
bool SendFacebookSignal(
   string symbol,      // e.g. "XAUUSD"
   string direction,   // "BUY" or "SELL"
   double entry,
   double sl,
   double tp1,
   double tp2 = 0,     // optional — pass 0 to omit
   double tp3 = 0,     // optional — pass 0 to omit
   string rr   = "1:3",
   string basis = "SMC Structure + Liquidity Grab + Daily Bias"
)
{
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);

   // Format numbers
   string sEntry = DoubleToString(entry, digits);
   string sSL    = DoubleToString(sl,    digits);
   string sTP1   = DoubleToString(tp1,   digits);
   string sTP2   = (tp2 > 0) ? DoubleToString(tp2, digits) : "—";
   string sTP3   = (tp3 > 0) ? DoubleToString(tp3, digits) : "—";

   // Build JSON payload
   string json = StringFormat(
      "{\"symbol\":\"%s\","
      "\"direction\":\"%s\","
      "\"entry\":\"%s\","
      "\"sl\":\"%s\","
      "\"tp1\":\"%s\","
      "\"tp2\":\"%s\","
      "\"tp3\":\"%s\","
      "\"rr\":\"%s\","
      "\"basis\":\"%s\"}",
      symbol, direction,
      sEntry, sSL, sTP1, sTP2, sTP3,
      rr, basis
   );

   // Send HTTP POST
   char   postData[];
   char   result[];
   string resultHeaders;
   StringToCharArray(json, postData, 0, StringLen(json));

   string headers = "Content-Type: application/json\r\n";

   int res = WebRequest(
      "POST",
      ServerURL,
      headers,
      Timeout,
      postData,
      result,
      resultHeaders
   );

   if(res == 200)
   {
      PrintFormat("[FacebookBridge] ✅ Signal sent: %s %s @ %s", symbol, direction, sEntry);
      return true;
   }
   else
   {
      PrintFormat("[FacebookBridge] ❌ Failed to send signal. HTTP code: %d", res);
      PrintFormat("[FacebookBridge] Make sure signal_server.py is running and");
      PrintFormat("[FacebookBridge] http://localhost:5005 is in MT5 allowed URLs.");
      return false;
   }
}

//+------------------------------------------------------------------+
//|  Example: call this from your existing EA signal logic           |
//|                                                                  |
//|  Replace the parameters with your EA's actual variables.        |
//+------------------------------------------------------------------+
/*

// ── EXAMPLE USAGE (paste into your EA's signal detection block) ──

double myEntry = Ask;                    // or your calculated entry
double mySL    = myEntry - 100 * Point;
double myTP1   = myEntry + 100 * Point;
double myTP2   = myEntry + 200 * Point;
double myTP3   = myEntry + 350 * Point;

SendFacebookSignal(
   _Symbol,      // current chart symbol
   "BUY",        // or "SELL"
   myEntry,
   mySL,
   myTP1,
   myTP2,
   myTP3,
   "1:3",
   "SMC Structure + Liquidity Grab + Daily Bias"
);

*/

//+------------------------------------------------------------------+
//|  OnStart — for testing only (remove from production EA)         |
//+------------------------------------------------------------------+
void OnStart()
{
   Print("[FacebookBridge] Test ping...");
   bool ok = SendFacebookSignal(
      "XAUUSD", "BUY",
      2318.00, 2308.00,
      2328.00, 2340.00, 2358.00,
      "1:4",
      "SMC Structure + Liquidity Grab + Daily Bias"
   );
   Print(ok ? "[FacebookBridge] Test OK!" : "[FacebookBridge] Test FAILED.");
}
