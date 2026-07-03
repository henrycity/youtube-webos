function isPrimitive(
  value: unknown
): value is string | number | boolean | null | undefined | symbol | bigint {
  return Object(value) !== value;
}

const originalStringify = JSON.stringify;

type FunctionReplacer = (this: any, key: string, value: any) => any;
type WhitelistReplacer = (string | number)[] | null;

function stringify(
  value: unknown,
  replacer?: FunctionReplacer | WhitelistReplacer,
  space?: string | number
): string {
  if (!isPrimitive(value)) {
    // TODO: add below to a dump-level logger
    // console.debug('JSON.stringify', value, replacer, space);

    const holder = value as Record<string, any>;
    const pbCtx = holder.playbackContext as Record<string, any> | undefined;
    const ctx = pbCtx?.contentPlaybackContext as
      | Record<string, unknown>
      | undefined;

    // Setting `isInlinePlaybackNoAd` tells InnerTube not to serve ads, which
    // avoids the server-side SABR "backoff" that otherwise stalls playback
    // after a few seconds. YouTube has shipped a "locker" script that defines
    // this property as non-writable/non-configurable via Object.defineProperty,
    // so a direct assignment (`ctx.isInlinePlaybackNoAd = true`) silently fails.
    //
    // Instead of mutating YouTube's object in place, rebuild the holder chain
    // with fresh plain objects. `JSON.stringify` only serializes own enumerable
    // properties, so spreading reproduces exactly what would be serialized while
    // dropping any locked property descriptors, letting our flag stick.
    //
    // We always rebuild if we detect the contentPlaybackContext to ensure
    // the flag is consistently set, even if it appears to already be true
    // on YouTube's locked object.
    if (!isPrimitive(ctx)) {
      const hadFlag = ctx!.isInlinePlaybackNoAd === true;
      
      // Log detailed information about the context object
      const ctxKeys = Object.keys(ctx!);
      const descriptor = Object.getOwnPropertyDescriptor(ctx!, 'isInlinePlaybackNoAd');
      
      console.debug(`[JSON.stringify] Found contentPlaybackContext, rebuilding...`, {
        propertyCount: ctxKeys.length,
        hadFlag,
        isInlinePlaybackNoAdPresent: 'isInlinePlaybackNoAd' in ctx!,
        descriptor: descriptor ? {
          writable: descriptor.writable,
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          value: descriptor.value
        } : 'undefined',
        contextType: Object.prototype.toString.call(ctx!).slice(8, -1)
      });
      
      value = {
        ...holder,
        playbackContext: {
          ...pbCtx,
          contentPlaybackContext: {
            ...ctx,
            isInlinePlaybackNoAd: true
          }
        }
      };
      
      if (!hadFlag) {
        console.info(`[JSON.stringify] Set isInlinePlaybackNoAd=true (was missing)`);
      } else {
        console.debug(`[JSON.stringify] Flag already set on object, rebuilt context anyway to bypass property locking on the original object`);
      }
    }
  }

  return originalStringify(value, replacer as any, space);
}

JSON.stringify = stringify;
