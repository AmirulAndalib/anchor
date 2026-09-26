import 'package:anchor/core/theme/app_theme.dart';
import 'package:anchor/features/notes/presentation/widgets/note_options_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Future<void> pumpSheet(
    WidgetTester tester, {
    bool isReadOnly = false,
    bool isOwner = true,
    bool isTrashed = false,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: Scaffold(
          body: NoteOptionsSheet(
            isReadOnly: isReadOnly,
            isNew: false,
            isOwner: isOwner,
            isTrashed: isTrashed,
            isArchived: false,
            onTagsTap: () {},
            onReminderTap: () {},
            onBackgroundTap: () {},
            onAttachmentTap: () {},
            onArchiveTap: () {},
            onDeleteTap: () {},
          ),
        ),
      ),
    );
  }

  testWidgets('the owner can tag, archive and delete', (tester) async {
    await pumpSheet(tester);

    expect(find.text('Tags'), findsOneWidget);
    expect(find.text('Archive'), findsOneWidget);
    expect(find.text('Delete'), findsOneWidget);
  });

  testWidgets('an editor can archive a shared note and remove it', (
    tester,
  ) async {
    await pumpSheet(tester, isOwner: false);

    expect(find.text('Archive'), findsOneWidget);
    expect(find.text('Remove'), findsOneWidget);
    expect(find.text('Delete'), findsNothing);
  });

  testWidgets('a viewer can tag, remind, archive and remove a shared note', (
    tester,
  ) async {
    await pumpSheet(tester, isOwner: false, isReadOnly: true);

    expect(find.text('Tags'), findsOneWidget);
    expect(find.text('Reminder'), findsOneWidget);
    expect(find.text('Archive'), findsOneWidget);
    expect(find.text('Remove'), findsOneWidget);
    expect(find.text('Background'), findsNothing);
  });

  testWidgets('a trashed note offers none of them', (tester) async {
    await pumpSheet(tester, isReadOnly: true, isTrashed: true);

    expect(find.text('Tags'), findsNothing);
    expect(find.text('Reminder'), findsNothing);
    expect(find.text('Archive'), findsNothing);
    expect(find.text('Delete'), findsNothing);
  });
}
