import 'package:anchor/core/network/server_config_provider.dart';
import 'package:anchor/core/theme/app_theme.dart';
import 'package:anchor/features/notes/domain/note.dart';
import 'package:anchor/features/notes/presentation/widgets/note_card.dart';
import 'package:anchor/features/tags/presentation/tags_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

void main() {
  Note noteWith(NoteReminder? reminder) => Note(
    id: 'n1',
    title: 'Hi',
    content: null,
    updatedAt: DateTime(2026, 9, 23, 19, 22),
    reminder: reminder,
  );

  /// Renders one card at a phone width, on the narrowest layout the grid uses.
  Future<void> pumpCard(WidgetTester tester, Note note, double width) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          tagsControllerProvider.overrideWith(TagsController.new),
          serverUrlProvider.overrideWithValue('https://example.test'),
        ],
        child: MaterialApp(
          theme: AppTheme.light(),
          home: Scaffold(
            body: Center(
              child: SizedBox(
                width: width,
                child: NoteCard(note: note),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  testWidgets('a long reminder label does not overflow the footer', (
    tester,
  ) async {
    // Half a 360pt screen minus gutters: the two-column grid's worst case.
    await pumpCard(
      tester,
      noteWith(
        const NoteReminder(
          remindAt: '2026-09-23T19:22',
          recurrence: ReminderRecurrence.yearly,
        ),
      ),
      160,
    );

    expect(tester.takeException(), isNull);
  });

  testWidgets('the reminder chip names the repeat in title case', (
    tester,
  ) async {
    await pumpCard(
      tester,
      noteWith(
        const NoteReminder(
          remindAt: '2026-09-23T19:22',
          recurrence: ReminderRecurrence.yearly,
        ),
      ),
      360,
    );

    expect(find.textContaining('· Yearly'), findsOneWidget);
  });

  testWidgets('a note with no title leads with its text', (tester) async {
    await pumpCard(
      tester,
      const Note(
        id: 'n1',
        title: '  ',
        content: '{"ops":[{"insert":"Buy milk\\n"}]}',
      ),
      160,
    );

    expect(find.text('Buy milk', findRichText: true), findsOneWidget);
    expect(find.text('Untitled'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a pinned note with no title keeps its pin', (tester) async {
    await pumpCard(
      tester,
      const Note(
        id: 'n1',
        title: '',
        content: '{"ops":[{"insert":"Buy milk\\n"}]}',
        isPinned: true,
      ),
      160,
    );

    expect(find.byIcon(LucideIcons.pin), findsOneWidget);
    expect(find.text('Buy milk', findRichText: true), findsOneWidget);
  });

  testWidgets('no reminder still lays out', (tester) async {
    await pumpCard(tester, noteWith(null), 160);
    expect(tester.takeException(), isNull);
  });
}
