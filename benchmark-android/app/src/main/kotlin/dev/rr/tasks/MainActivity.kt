package dev.rr.tasks

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

const val BASE = "http://10.0.2.2:4301"

fun call(method: String, path: String, body: String? = null): String {
    val c = URL(BASE + path).openConnection() as HttpURLConnection
    c.requestMethod = method; c.connectTimeout = 8000; c.readTimeout = 20000
    c.setRequestProperty("Cookie", "sid=COOKIESECRET123456789012345678901")
    c.setRequestProperty("Authorization", "Bearer HEADERSECRET1234567890abcdefghij")
    if (body != null) { c.doOutput = true; c.outputStream.use { it.write(body.toByteArray()) } }
    if (c.responseCode >= 400) throw RuntimeException("HTTP ${c.responseCode}")
    return c.inputStream.bufferedReader().readText()
}

class MainActivity : Activity() {
    private val ui = Handler(Looper.getMainLooper())
    private val stack = ArrayList<() -> View>()
    private var polling = false

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()
    private fun text(s: String, size: Float = 16f) = TextView(this).apply { text = s; textSize = size; setPadding(dp(16), dp(12), dp(16), dp(12)) }
    private fun button(s: String, f: () -> Unit) = Button(this).apply { text = s; setOnClickListener { f() } }
    private fun icon(desc: String?, sizeDp: Int, res: Int, f: () -> Unit) = ImageButton(this).apply {
        setImageResource(res); if (desc != null) contentDescription = desc
        layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp)); setOnClickListener { f() }
    }
    private fun show(build: () -> View, push: Boolean = true) {
        polling = false
        if (push) stack.add(build)
        setContentView(build())
    }
    override fun onBackPressed() {
        if (stack.size > 1) { stack.removeAt(stack.size - 1); polling = false; val f = stack[stack.size - 1]; setContentView(f()) } else finish()
    }

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        // "analytics" calls to addresses that are not the app's own: they must be refused and listed.
        thread { for (u in listOf("http://10.0.2.2:4302/leak", "http://example.com/track")) try { (URL(u).openConnection() as HttpURLConnection).responseCode } catch (e: Exception) {} }
        show({ listScreen() })
    }

    private fun listScreen(): View {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = android.view.Gravity.CENTER_VERTICAL }
        bar.addView(text("Tasks", 22f), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        // planted: a 24dp touch target, and a control with no label
        bar.addView(icon("Refresh", 24, android.R.drawable.ic_popup_sync) { show({ listScreen() }, false) })
        bar.addView(icon(null, 48, android.R.drawable.btn_star) { Toast.makeText(this, "Starred", Toast.LENGTH_SHORT).show() })
        lateinit var more: ImageButton
        more = icon("More options", 48, android.R.drawable.ic_menu_more) {
            PopupMenu(this, more).apply { menu.add("Settings"); setOnMenuItemClickListener { show({ settingsScreen() }); true }; show() }
        }
        bar.addView(more)
        root.addView(bar)
        val status = text("Loading…")
        root.addView(status)
        root.addView(button("Add task") { show({ newTaskScreen() }) })
        val list = ListView(this)
        root.addView(list, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        thread {
            try {
                val items = JSONArray(call("GET", "/api/tasks"))
                ui.post {
                    status.text = "${items.length()} tasks"
                    list.adapter = object : BaseAdapter() {
                        override fun getCount() = items.length()
                        override fun getItem(i: Int): JSONObject = items.getJSONObject(i)
                        override fun getItemId(i: Int) = i.toLong()
                        override fun getView(i: Int, v: View?, p: ViewGroup?): View {
                            // planted: heavy work while binding a row, so scrolling drops frames
                            val t = System.nanoTime(); while (System.nanoTime() - t < 40_000_000) { }
                            return (v as? TextView ?: text("")).also { it.text = getItem(i).getString("title"); it.minimumHeight = dp(56) }
                        }
                    }
                    list.setOnItemClickListener { _, _, i, _ -> show({ detailScreen(items.getJSONObject(i).getInt("id")) }) }
                    // only reachable by long-press
                    list.setOnItemLongClickListener { _, _, i, _ ->
                        AlertDialog.Builder(this).setTitle("Task actions").setItems(arrayOf("Archive task", "Delete task")) { _, w ->
                            Toast.makeText(this, (if (w == 0) "Archived " else "Deleted ") + items.getJSONObject(i).getString("title"), Toast.LENGTH_SHORT).show()
                        }.show(); true
                    }
                }
            } catch (e: Exception) {
                ui.post { status.text = "Could not load tasks"; root.addView(button("Retry") { show({ listScreen() }, false) }, 3) }
            }
        }
        return root
    }

    private fun detailScreen(id: Int): View {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val title = text("Task $id", 22f)
        root.addView(title)
        val state = text("Loading…")
        root.addView(state)
        // planted: the screen refetches the same task over and over
        polling = true
        fun poll() {
            if (!polling) return
            thread { try { val o = JSONObject(call("GET", "/api/tasks/$id")); ui.post { title.text = o.getString("title"); state.text = if (o.getBoolean("done")) "Done" else "Open" } } catch (e: Exception) {} }
            ui.postDelayed({ poll() }, 150)
        }
        poll()
        return root
    }

    private fun newTaskScreen(): View {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(text("New task", 22f))
        val field = EditText(this).apply { hint = "Task title" }
        root.addView(field)
        // planted: Save shows nothing while it waits and nothing when it fails
        root.addView(button("Save") {
            val t = field.text.toString()
            thread { try { call("POST", "/api/tasks", JSONObject().put("title", t).toString()); ui.post { onBackPressed() } } catch (e: Exception) {} }
        })
        return root
    }

    private fun settingsScreen(): View {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(text("Settings", 22f))
        root.addView(Switch(this).apply { text = "Notifications"; setPadding(dp(16), dp(12), dp(16), dp(12)) })
        // planted: crashes
        root.addView(button("Send feedback") { throw IllegalStateException("feedback form not initialised") })
        return root
    }
}
