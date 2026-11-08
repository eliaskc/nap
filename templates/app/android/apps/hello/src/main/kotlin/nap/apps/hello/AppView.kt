package nap.apps.hello

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/** Every app has an AppView in its package, nap.apps.<slug>. The launcher shows it full screen. */
@Composable
fun AppView() {
  var taps by rememberSaveable { mutableIntStateOf(0) }
  Column(
    Modifier.fillMaxSize(),
    verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text("Hello from Nap", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
    Button(onClick = { taps += 1 }) { Text("Tapped $taps times") }
  }
}
