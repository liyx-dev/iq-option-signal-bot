/*
 * IQ Option adapter boundary.
 *
 * IMPORTANT:
 * - This module intentionally does NOT accept IQ Option email/password/SSID.
 * - The community IQ Option protocol is unofficial and can change.
 * - No unauthenticated public OTC endpoint is assumed here.
 *
 * Future read-only integration can implement this interface behind a separate
 * connector/bridge without changing the signal engine:
 *
 *   getCandles(iqSymbol, timeframeSeconds)
 *   getServerTime()
 *   getAssetStatus(iqSymbol)
 *
 * Until a legitimate credential-free/public feed is verified, returning
 * "UNAVAILABLE" is safer than pretending external FX data is IQ Option OTC data.
 */
export class IQOptionProvider {
  constructor(env){
    this.name="iqoption";
    this.enabled=String(env.IQ_OPTION_PUBLIC_DATA_ENABLED||"false")==="true";
  }

  async status(){
    return {
      provider:this.name,
      enabled:this.enabled,
      mode:this.enabled?"PUBLIC_BRIDGE_CONFIGURED":"NOT_CONNECTED",
      note:"No IQ Option credentials are stored or requested by this Worker."
    };
  }
}

