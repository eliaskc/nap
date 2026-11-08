package nap.launcher

import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.Crossfade
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import nap.kit.Nap
import nap.kit.NapSignInButton

/** An app in apps/: the registry (generated from their app.json) lists them all. */
class AppEntry(
  val slug: String,
  val title: String,
  val summary: String,
  /** The page on Nap the app plays with. */
  val site: String,
  val view: @Composable () -> Unit,
)

/**
 * The launcher: every app in apps/, in the order of the registry. Apps open full screen; back,
 * or the close button in the top corner, comes back. It also signs in to Nap once for every app
 * (NapKit).
 */
class MainActivity : ComponentActivity() {
  /** An app the intent asked to open, until the launcher has opened it. */
  private var requested by mutableStateOf<String?>(null)

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    if (savedInstanceState == null) handle(intent)
    setContent {
      LauncherTheme {
        Launcher(requested) { requested = null }
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handle(intent)
  }

  /**
   * `-e open <slug>` opens that app, and `-e site <id>` the app whose app.json names that page
   * (what a notification will ask for). `-e nap-url` and `-e nap-token` are for testing.
   */
  private fun handle(intent: Intent) {
    Nap.handleTestingExtras(intent.extras)
    val slug = intent.getStringExtra("open")
    val site = intent.getStringExtra("site")
    registry.firstOrNull { it.slug == slug || (!site.isNullOrEmpty() && it.site == site) }?.let { requested = it.slug }
  }
}

@Composable
fun LauncherTheme(content: @Composable () -> Unit) {
  val dark = isSystemInDarkTheme()
  val context = LocalContext.current
  val colors = when {
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
    dark -> darkColorScheme()
    else -> lightColorScheme()
  }
  MaterialTheme(colorScheme = colors, content = content)
}

@Composable
fun Launcher(requested: String?, onRequestHandled: () -> Unit) {
  var open by rememberSaveable { mutableStateOf<String?>(null) }
  LaunchedEffect(requested) {
    if (requested != null) {
      open = requested
      onRequestHandled()
    }
  }
  val app = registry.firstOrNull { it.slug == open }
  Crossfade(app, label = "app") { shown ->
    if (shown != null) {
      BackHandler { open = null }
      AppScreen(shown) { open = null }
    } else {
      AppList { open = it.slug }
    }
  }
}

/** An app, full screen, inside the system bars, with a close button in the top corner. */
@Composable
fun AppScreen(app: AppEntry, close: () -> Unit) {
  Surface(Modifier.fillMaxSize()) {
    Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
      app.view()
      FilledTonalIconButton(onClick = close, modifier = Modifier.align(Alignment.TopEnd).padding(8.dp)) {
        Icon(Icons.Filled.Close, contentDescription = "Close app")
      }
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppList(onOpen: (AppEntry) -> Unit) {
  val account = Nap.account
  val context = LocalContext.current
  val build = remember {
    context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode
  }
  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text(Nap.appName) },
        actions = { if (account.signedIn) AccountMenu() },
      )
    },
  ) { padding ->
    LazyColumn(Modifier.fillMaxSize(), contentPadding = padding) {
      if (!account.signedIn) {
        item {
          Card(Modifier.fillMaxWidth().padding(16.dp)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
              Text("Sign in to ${Nap.host} once, for every app here.", style = MaterialTheme.typography.bodyMedium)
              NapSignInButton()
            }
          }
        }
      }
      items(registry, key = { it.slug }) { app ->
        ListItem(
          headlineContent = { Text(app.title) },
          supportingContent = app.summary.takeIf { it.isNotEmpty() }?.let { { Text(it) } },
          modifier = Modifier.clickable { onOpen(app) },
        )
        HorizontalDivider()
      }
      item {
        Text(
          "Build $build",
          style = MaterialTheme.typography.labelSmall,
          color = MaterialTheme.colorScheme.outline,
          modifier = Modifier.fillMaxWidth().padding(16.dp),
          textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
      }
    }
  }
}

@Composable
private fun AccountMenu() {
  val account = Nap.account
  var expanded by remember { mutableStateOf(false) }
  Box {
    IconButton(onClick = { expanded = true }) {
      Icon(Icons.Filled.AccountCircle, contentDescription = "Account")
    }
    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
      if (account.displayName.isNotEmpty()) {
        DropdownMenuItem(text = { Text(account.displayName) }, onClick = {}, enabled = false)
      }
      DropdownMenuItem(
        text = { Text("Sign out") },
        onClick = {
          expanded = false
          account.signOut()
        },
      )
    }
  }
}
