package io.github.luisfpal.vicaria

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Remote WebView debugging (chrome://inspect) only in debug builds; a release build never exposes the page.
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
