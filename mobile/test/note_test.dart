import 'package:anchor/features/notes/domain/note.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('a blank title counts as no title', () {
    expect(const Note(id: 'n1', title: '').hasTitle, isFalse);
    expect(const Note(id: 'n1', title: '  ').hasTitle, isFalse);
    expect(const Note(id: 'n1', title: 'Groceries ').hasTitle, isTrue);
  });

  test('permission gates editing', () {
    expect(const Note(id: 'n1', title: '').canEdit, isTrue); // owner default
    expect(
      const Note(
        id: 'n1',
        title: '',
        permission: NotePermission.editor,
      ).canEdit,
      isTrue,
    );
    expect(
      const Note(
        id: 'n1',
        title: '',
        permission: NotePermission.viewer,
      ).canEdit,
      isFalse,
    );
  });
}
