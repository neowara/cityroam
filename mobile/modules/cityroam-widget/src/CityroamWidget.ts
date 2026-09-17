import { NativeModule, requireNativeModule } from 'expo';

declare class CityroamWidgetModule extends NativeModule<{}> {
  updateSnapshot(snapshotJson: string): void;
  /** Renders the widget's card through the same native code path the placed widget uses,
   * at an arbitrary size, and returns a file:// path to the resulting PNG — for
   * Settings' live preview (WidgetPreview.tsx). Absent on a dev client built without the
   * native widget module; callers must handle that the same way updateSnapshot's callers
   * already handle a missing native module. */
  renderPreview(snapshotJson: string, widthDp: number, heightDp: number): Promise<string>;
}

export default requireNativeModule<CityroamWidgetModule>('CityroamWidget');
