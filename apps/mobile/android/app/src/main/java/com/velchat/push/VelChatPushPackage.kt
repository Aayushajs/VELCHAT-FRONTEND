package com.velchat.push

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers {@link VelChatPushModule}. Added by hand in `MainApplication` — there is no
 * autolinking for a module that lives inside the app itself.
 *
 * `BaseReactPackage` (not the deprecated `createNativeModules` path) so the module is created
 * LAZILY: nothing here runs until JS first touches `NativeModules.VelChatPush`, which keeps it
 * off the cold-start critical path (§R4).
 */
class VelChatPushPackage : BaseReactPackage() {

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == VelChatPushModule.NAME) VelChatPushModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
        VelChatPushModule.NAME to
            ReactModuleInfo(
                VelChatPushModule.NAME,
                VelChatPushModule::class.java.name,
                /* canOverrideExistingModule = */ false,
                // Not eager: the JS side calls `initPush()` from an effect, and pulling a
                // Firebase token during bridge startup would put a network-capable subsystem on
                // the cold-start path for no benefit.
                /* needsEagerInit = */ false,
                /* isCxxModule = */ false,
                // Bridgeless routes legacy modules through the interop layer; declaring this a
                // TurboModule without a codegen spec would make the lookup fail outright.
                /* isTurboModule = */ false,
            ))
  }
}
