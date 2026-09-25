import 'dart:convert';

import 'package:anchor/core/theme/app_theme.dart';
import 'package:anchor/features/notes/domain/note_diff.dart';
import 'package:anchor/features/notes/presentation/widgets/note_diff_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

String orderedList(List<String> items) => jsonEncode({
  'ops': [
    for (final item in items) ...[
      {'insert': item},
      {
        'insert': '\n',
        'attributes': {'list': 'ordered'},
      },
    ],
  ],
});

Future<void> pumpDiff(WidgetTester tester, ContentDiff diff) =>
    tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: NoteDiffBody(diff: diff)),
      ),
    );

Future<void> pumpTitle(WidgetTester tester, NoteDiffTitle title) =>
    tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: Scaffold(body: title),
      ),
    );

void main() {
  testWidgets('a version with no title shows no title', (tester) async {
    await pumpTitle(tester, const NoteDiffTitle(title: '  '));

    expect(find.byType(Text), findsNothing);
  });

  testWidgets('a title added where there was none shows only the new one', (
    tester,
  ) async {
    await pumpTitle(
      tester,
      const NoteDiffTitle(title: '', replacedBy: 'Groceries'),
    );

    expect(find.byType(Text), findsOneWidget);
    expect(find.text('Groceries'), findsOneWidget);
  });

  testWidgets('a removed title shows only the old one', (tester) async {
    await pumpTitle(
      tester,
      const NoteDiffTitle(title: 'Groceries', replacedBy: ''),
    );

    expect(find.byType(Text), findsOneWidget);
    final old = tester.widget<Text>(find.text('Groceries'));
    expect(old.style?.decoration, TextDecoration.lineThrough);
  });

  testWidgets('each side of the diff numbers its own version of a list', (
    tester,
  ) async {
    final diff = diffNoteContent(
      orderedList(['apples', 'pears']),
      orderedList(['oranges', 'pears']),
    );
    await pumpDiff(tester, diff);

    // Removed "apples" and added "oranges" are both first in their version;
    // unchanged "pears" is second in both.
    expect(find.text('1.'), findsNWidgets(2));
    expect(find.text('2.'), findsOneWidget);
    expect(find.text('3.'), findsNothing);
  });

  testWidgets('an unchanged list keeps its numbering', (tester) async {
    final content = orderedList(['milk', 'eggs', 'bread']);
    await pumpDiff(tester, diffNoteContent(content, content));

    expect(find.text('1.'), findsOneWidget);
    expect(find.text('2.'), findsOneWidget);
    expect(find.text('3.'), findsOneWidget);
  });
}
