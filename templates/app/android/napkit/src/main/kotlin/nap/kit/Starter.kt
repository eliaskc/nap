package nap.kit

import android.app.Activity
import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.lang.ref.WeakReference
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Starts NapKit when the app starts (declared in NapKit's manifest), and follows the activities:
 * the sign-in opens its page from the one in front, and coming back to the foreground
 * reconnects live updates.
 */
class NapStarter : ContentProvider() {
  override fun onCreate(): Boolean {
    val app = context?.applicationContext as? Application ?: return false
    Nap.start(app)
    app.registerActivityLifecycleCallbacks(Activities)
    return true
  }

  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?) = null
  override fun getType(uri: Uri): String? = null
  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
  override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0
}

internal object Activities : Application.ActivityLifecycleCallbacks {
  private var started = 0
  private var current = WeakReference<Activity>(null)

  /** The activity in front, if any. */
  val front: Activity? get() = current.get()

  override fun onActivityStarted(activity: Activity) {
    if (started++ == 0 && Nap.account.signedIn) Nap.foreground()
  }
  override fun onActivityStopped(activity: Activity) {
    started = maxOf(0, started - 1)
  }
  override fun onActivityResumed(activity: Activity) {
    current = WeakReference(activity)
  }
  override fun onActivityCreated(activity: Activity, state: Bundle?) {
    current = WeakReference(activity)
  }
  override fun onActivityPaused(activity: Activity) {}
  override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
  override fun onActivityDestroyed(activity: Activity) {}
}

/**
 * Secrets on the device: values in the app's preferences, encrypted with an AES key that never
 * leaves the Android Keystore. A value that cannot be decrypted (such as one restored from a
 * backup on another phone) reads as missing.
 */
internal object Vault {
  private const val ALIAS = "nap.kit.vault"
  private val prefs by lazy { Nap.context.getSharedPreferences("nap.kit.vault", Context.MODE_PRIVATE) }

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return generator.generateKey()
  }

  fun read(name: String): String? {
    val stored = prefs.getString(name, null) ?: return null
    return runCatching {
      val bytes = Base64.decode(stored, Base64.NO_WRAP)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
      cipher.doFinal(bytes, 12, bytes.size - 12).decodeToString()
    }.getOrNull()
  }

  fun write(name: String, value: String?) {
    if (value == null) {
      prefs.edit().remove(name).apply()
      return
    }
    runCatching {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, key())
      val sealed = cipher.iv + cipher.doFinal(value.encodeToByteArray())
      prefs.edit().putString(name, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
    }
  }
}
