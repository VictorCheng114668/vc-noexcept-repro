# Repro: JS exception escaping a VisionCamera frame callback terminates the process (iOS release)

Minimal reproduction for the react-native-vision-camera issue:

> The generated `Func_*_Wrapper::call()` classes in `VisionCamera-Swift-Cxx-Bridge.hpp`
> are declared `noexcept` but invoke the **throwing** `std::function::operator()`.
> Any exception crossing one of these wrappers — e.g. a JS error from a frame-stream
> callback — escapes a `noexcept` function, so the C++ runtime calls
> `std::terminate` and the app dies with SIGABRT on queue `com.margelo.camera.frame`.
> There is no possible catch site, from JS or from user native code.

## Environment

| Component        | Version                  |
| ---------------- | ------------------------ |
| react-native-vision-camera | 5.2.3 (latest) |
| react-native-nitro-modules | 0.37.1 (latest) |
| react-native     | 0.86.3 (Expo SDK 57)     |
| react-native-worklets | 0.10.1              |
| Device           | iPhone XR, iOS 18.7.10 (any release build reproduces) |

## Steps

1. `npm install`
2. `npx expo prebuild --platform ios`
3. Produce a **release** build and install it on a device — e.g. `eas build --platform ios --profile production`, or archive from Xcode.
4. Open the app, grant the camera permission.

**Expected:** the app aborts (SIGABRT) as soon as the frame output attaches. Symbolicating the crash shows:

```
std::terminate → _objc_terminate → <app> (generated Func_*_Wrapper frame)
→ __dispatch_call_block_and_release · queue: com.margelo.camera.frame
```

Dev builds may not reproduce — the worklets dev pipeline intercepts JS errors earlier, before they cross the noexcept boundary.

## The trigger, and why it is a JS-side *throwing* callback

`App.tsx` registers a frame callback whose worklet assigns to a captured module-scope `let` (minimized verbatim from the production code where we first hit this):

```ts
const SCAN_FRAME_INTERVAL_MS = 750;
let lastScanFrameAt = 0;
let scanFrameHandler: ((payload: { at: number }) => void) | null = null;

function dispatchScanFrame(payload: { at: number }) {
  'worklet';
  scanFrameHandler?.(payload);
}

function onReferenceScanFrame(frame: Frame) {
  'worklet';
  try {
    const now = Date.now();
    if (now - lastScanFrameAt < SCAN_FRAME_INTERVAL_MS) return;
    lastScanFrameAt = now; // assignment to a captured binding
    scheduleOnRN(dispatchScanFrame, { at: now });
  } catch {
    // ...
  } finally {
    frame.dispose();
  }
}
```

The react-native-worklets babel plugin packs captured bindings as a **const** destructure, so the packed `initData.code` shipped to the device is (verbatim from the real babel output):

```js
function onReferenceScanFrame_AppTsx2(frame){const{lastScanFrameAt,SCAN_FRAME_INTERVAL_MS,scheduleOnRN,dispatchScanFrame}=this.__closure;try{const now=Date.now();if(now-lastScanFrameAt<SCAN_FRAME_INTERVAL_MS){return;}lastScanFrameAt=now;scheduleOnRN(dispatchScanFrame,{at:now});}catch{}finally{frame.dispose();}}
//                                                assignment to a const ——^^^^^^^^^^^^^^^
```

Hermes rejects const assignment at **parse** time, so this source can never be eval'd on-device — you can verify that on any desktop without running the app:

```sh
hermesc -emit-binary -out w.hbc w.js   # w.js = the packed code above, wrapped in ( ... )
# → error: 1:219:invalid assignment left-hand side
```

The same error message was captured on-device from the crashing production build's logs: `1:277:invalid assignment left-hand side ... at valueUnpacker` (column differs only because the production worklet was slightly longer).

At runtime, `valueUnpacker`'s `eval('(' + initData.code + '\n)')` throws while the registration pipeline deserializes the worklet on the camera's native thread — inside the functor scheduled through `HybridNativeThreadSpec::runOnThread`, i.e. the generated `Func_void_Wrapper`. That wrapper is `noexcept`; `std::function<void()>::operator()` propagates the exception; `std::terminate` follows.

(The const-closure packing itself is a separate react-native-worklets issue; it is used here only because it is the shortest **fully verified** path to a JS exception crossing the boundary. The defect reported against VisionCamera is that *any* such exception is an unrecoverable process kill instead of a surfaced error.)

## Root cause, in the generated code

`node_modules/react-native-vision-camera/nitrogen/generated/ios/c++/VisionCamera-Swift-Cxx-Bridge.hpp` generates ~26 `Func_*_Wrapper` classes. Each `call`/`operator()` is declared `noexcept` and then calls `std::function<...>::operator()`, which is not `noexcept`: it throws `std::bad_function_call` for empty targets and propagates any exception thrown by the wrapped callable. Per `[except.spec]`, an exception escaping a `noexcept` function invokes `std::terminate` — uncatchable by definition.

Affected paths include the frame callback, the frame-dropped callback, `HybridNativeThreadSpec::runOnThread` (`Func_void_Wrapper` — the one this repro kills on), error callbacks, and sync bridge calls.

## Suggested fix (validated on-device)

Wrap the `_func(...)` invocation in each generated wrapper:

```cpp
try {
  return _func(/* ... */);
} catch (const std::exception& e) {
  // report e.what() to the JS error handler / os_log
} catch (...) {
  // report unknown error
}
```

We applied exactly this shape (guard + log + default return) to all 26 wrappers via a patch-package patch in our production app: the terminate disappeared and the underlying JS error became visible in logs for the first time.

## Workaround for app authors

There is no user-space workaround for the terminate itself (a `noexcept` boundary cannot be made catchable from outside). The specific trigger above can be avoided by never assigning to captured bindings in worklets — mutate a property of a captured object instead (`const box = {n: 0}; box.n += 1`).
