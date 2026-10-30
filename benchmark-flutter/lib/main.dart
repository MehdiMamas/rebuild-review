import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';

const base = 'http://10.0.2.2:4301';

Future<dynamic> call(String method, String path, [String? body]) async {
  final c = HttpClient()..connectionTimeout = const Duration(seconds: 8);
  final r = await c.openUrl(method, Uri.parse(base + path));
  r.headers.set('Cookie', 'sid=COOKIESECRET123456789012345678901');
  r.headers.set('Authorization', 'Bearer HEADERSECRET1234567890abcdefghij');
  if (body != null) r.write(body);
  final res = await r.close();
  final text = await res.transform(utf8.decoder).join();
  c.close();
  if (res.statusCode >= 400) throw Exception('HTTP ${res.statusCode}');
  return jsonDecode(text);
}

void main() {
  // "analytics" calls to addresses that are not the app's own: they must be refused and listed.
  for (final u in ['http://10.0.2.2:4302/leak', 'http://example.com/track']) {
    HttpClient().getUrl(Uri.parse(u)).then((r) => r.close()).then((_) {}, onError: (_) {});
  }
  runApp(const MaterialApp(title: 'Tasks', home: ListScreen()));
}

class ListScreen extends StatefulWidget {
  const ListScreen({super.key});
  @override
  State<ListScreen> createState() => _ListScreenState();
}

class _ListScreenState extends State<ListScreen> {
  String status = 'Loading…';
  bool failed = false;
  List items = [];

  @override
  void initState() { super.initState(); load(); }

  Future<void> load() async {
    setState(() { status = 'Loading…'; failed = false; });
    try {
      final r = await call('GET', '/api/tasks');
      setState(() { items = r; status = '${r.length} tasks'; });
    } catch (e) {
      setState(() { status = 'Could not load tasks'; failed = true; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Tasks'), actions: [
        // planted: a 24 dp touch target, and a control with no label
        Semantics(label: 'Refresh', button: true, child: GestureDetector(onTap: load, child: const SizedBox(width: 24, height: 24, child: Icon(Icons.refresh, size: 20)))),
        GestureDetector(onTap: () {}, child: const SizedBox(width: 48, height: 48, child: Icon(Icons.star))),
        PopupMenuButton<String>(
          onSelected: (_) => Navigator.push(context, MaterialPageRoute(builder: (_) => const SettingsScreen())),
          itemBuilder: (_) => const [PopupMenuItem(value: 'settings', child: Text('Settings'))],
        ),
      ]),
      body: Column(children: [
        Padding(padding: const EdgeInsets.all(12), child: Text(status)),
        if (failed) ElevatedButton(onPressed: load, child: const Text('Retry')),
        ElevatedButton(onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const NewTaskScreen())).then((_) => load()), child: const Text('Add task')),
        Expanded(
          child: ListView.builder(
            itemCount: items.length,
            itemBuilder: (_, i) {
              // planted: heavy work while building a row, so scrolling drops frames
              final sw = Stopwatch()..start();
              while (sw.elapsedMilliseconds < 40) {}
              final t = items[i];
              return ListTile(
                title: Text(t['title']),
                onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => DetailScreen(id: t['id']))),
                // only reachable by long-press
                onLongPress: () => showDialog(context: context, builder: (_) => SimpleDialog(title: const Text('Task actions'), children: [
                  SimpleDialogOption(onPressed: () => Navigator.pop(context), child: const Text('Archive task')),
                  SimpleDialogOption(onPressed: () => Navigator.pop(context), child: const Text('Delete task')),
                ])),
              );
            },
          ),
        ),
      ]),
    );
  }
}

class DetailScreen extends StatefulWidget {
  final int id;
  const DetailScreen({super.key, required this.id});
  @override
  State<DetailScreen> createState() => _DetailScreenState();
}

class _DetailScreenState extends State<DetailScreen> {
  String title = '';
  String state = 'Loading…';
  bool alive = true;

  @override
  void initState() { super.initState(); title = 'Task ${widget.id}'; poll(); }
  @override
  void dispose() { alive = false; super.dispose(); }

  // planted: the screen refetches the same task over and over
  Future<void> poll() async {
    while (alive) {
      try {
        final o = await call('GET', '/api/tasks/${widget.id}');
        if (alive) setState(() { title = o['title']; state = o['done'] ? 'Done' : 'Open'; });
      } catch (_) {}
      await Future.delayed(const Duration(milliseconds: 150));
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: Text(title)), body: Padding(padding: const EdgeInsets.all(16), child: Text(state)));
}

class NewTaskScreen extends StatelessWidget {
  const NewTaskScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final c = TextEditingController();
    return Scaffold(
      appBar: AppBar(title: const Text('New task')),
      body: Padding(padding: const EdgeInsets.all(16), child: Column(children: [
        TextField(controller: c, decoration: const InputDecoration(labelText: 'Task title')),
        // planted: Save shows nothing while it waits and nothing when it fails
        ElevatedButton(
          onPressed: () async {
            try {
              await call('POST', '/api/tasks', jsonEncode({'title': c.text}));
              if (context.mounted) Navigator.pop(context);
            } catch (_) {}
          },
          child: const Text('Save'),
        ),
      ])),
    );
  }
}

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Settings')),
    body: Column(children: [
      SwitchListTile(title: const Text('Notifications'), value: false, onChanged: (_) {}),
      // planted: throws
      ElevatedButton(onPressed: () async { throw StateError('feedback form not initialised'); }, child: const Text('Send feedback')),
    ]),
  );
}
