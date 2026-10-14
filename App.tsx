import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  useCameraPermission,
  useFrameOutput,
  type Frame,
} from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';

/**
 * The trigger, minimized from a production crash: a frame worklet that
 * assigns to a captured module-scope `let`.
 *
 * The react-native-worklets babel plugin packs captured bindings as a const
 * destructure (`const {lastScanFrameAt, ...} = this.__closure`), so the
 * packed worklet source contains an assignment to a const binding. Hermes
 * rejects that at PARSE time ("invalid assignment left-hand side"), so this
 * worklet can never be eval'd on-device — valueUnpacker throws while the
 * registration pipeline deserializes it on the camera's native thread.
 *
 * That exception then escapes through the generated
 * `Func_void_Wrapper::call` (HybridNativeThreadSpec::runOnThread) in
 * VisionCamera-Swift-Cxx-Bridge.hpp, which is declared `noexcept` yet calls
 * the throwing `std::function<void()>::operator()` — so instead of a catchable
 * error the process dies in std::terminate on queue com.margelo.camera.frame.
 *
 * Any other JS exception crossing one of these wrappers behaves the same;
 * this trigger is just the shortest fully-verified path. See README.md.
 */
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
    if (now - lastScanFrameAt < SCAN_FRAME_INTERVAL_MS) {
      return;
    }
    lastScanFrameAt = now; // ← the poison: assignment to a captured `let`
    scheduleOnRN(dispatchScanFrame, { at: now });
  } catch {
    // Containment can't help: the failure is at parse time, before any of
    // this body ever runs.
  } finally {
    frame.dispose();
  }
}

export default function App() {
  const { hasPermission, requestPermission } = useCameraPermission();

  useEffect(() => {
    if (!hasPermission) requestPermission().catch(() => {});
  }, [hasPermission, requestPermission]);

  const frameOutput = useFrameOutput({ onFrame: onReferenceScanFrame });

  return (
    <View style={styles.screen}>
      {hasPermission ? (
        <Camera
          style={StyleSheet.absoluteFill}
          device="back"
          isActive
          outputs={[frameOutput]}
        />
      ) : (
        <Text style={styles.text}>Waiting for camera permission…</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  text: { color: '#fff' },
});
