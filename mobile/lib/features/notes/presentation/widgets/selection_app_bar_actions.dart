import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:anchor/features/notes/domain/note.dart';
import 'package:anchor/core/widgets/confirm_dialog.dart';
import 'package:anchor/core/widgets/quill_preview.dart'
    show extractPlainTextFromQuillContent;
import 'package:anchor/core/widgets/app_snackbar.dart';
import 'package:anchor/features/tags/presentation/widgets/tag_selector.dart';
import '../notes_controller.dart';
import 'package:anchor/core/widgets/app_bottom_sheet.dart';

class SelectionAppBarActions extends ConsumerWidget {
  final Set<String> selectedNoteIds;
  final VoidCallback onExitSelectionMode;

  const SelectionAppBarActions({
    super.key,
    required this.selectedNoteIds,
    required this.onExitSelectionMode,
  });

  Future<void> _handleArchive(
    BuildContext context,
    WidgetRef ref,
    List<String> ids,
  ) async {
    final theme = Theme.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => ConfirmDialog(
        icon: LucideIcons.archive,
        iconColor: theme.colorScheme.primary,
        title: 'Archive ${_notes(ids.length)}?',
        message: '${_these(ids.length)} will be moved to archive.',
        cancelText: 'Cancel',
        confirmText: 'Archive',
        onConfirm: () {},
      ),
    );
    if (confirmed == true && context.mounted) {
      try {
        await ref.read(notesControllerProvider.notifier).bulkArchiveNotes(ids);
        onExitSelectionMode();
        if (context.mounted) {
          AppSnackbar.showSuccess(
            context,
            message: '${_notes(ids.length)} archived',
          );
        }
      } catch (e) {
        if (context.mounted) {
          AppSnackbar.showError(context, message: 'Failed to archive notes');
        }
      }
    }
  }

  Future<void> _handleDelete(
    BuildContext context,
    WidgetRef ref,
    List<String> ids,
    int sharedCount,
  ) async {
    final theme = Theme.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => ConfirmDialog(
        icon: LucideIcons.trash2,
        iconColor: theme.colorScheme.error,
        title: 'Delete ${_notes(ids.length)}?',
        message: _deleteMessage(ids.length, sharedCount),
        cancelText: 'Cancel',
        confirmText: 'Delete',
        onConfirm: () {},
      ),
    );
    if (confirmed == true && context.mounted) {
      try {
        await ref.read(notesControllerProvider.notifier).bulkDeleteNotes(ids);
        onExitSelectionMode();
        if (context.mounted) {
          AppSnackbar.showSuccess(
            context,
            message: _deletedMessage(ids.length, sharedCount),
          );
        }
      } catch (e) {
        if (context.mounted) {
          AppSnackbar.showError(context, message: 'Failed to delete notes');
        }
      }
    }
  }

  String _notes(int count) => '$count ${count == 1 ? 'note' : 'notes'}';

  String _these(int count) => count == 1 ? 'This note' : 'These notes';

  String _deleteMessage(int count, int sharedCount) {
    if (sharedCount == 0) return '${_these(count)} will be moved to trash.';
    if (sharedCount == count) {
      return '${_these(count)} will be removed from your notes.';
    }
    return 'Notes you own will be moved to trash. '
        'Shared notes will be removed from your notes.';
  }

  String _deletedMessage(int count, int sharedCount) {
    if (sharedCount == 0) return '${_notes(count)} moved to trash';
    if (sharedCount == count) return '${_notes(count)} removed';
    return '${_notes(count)} deleted';
  }

  Future<void> _handlePin(
    BuildContext context,
    WidgetRef ref,
    List<String> ids,
    bool isPinned,
  ) async {
    try {
      await ref
          .read(notesControllerProvider.notifier)
          .bulkSetPinned(ids, isPinned);
      onExitSelectionMode();
      if (context.mounted) {
        AppSnackbar.showSuccess(
          context,
          message: '${_notes(ids.length)} ${isPinned ? 'pinned' : 'unpinned'}',
        );
      }
    } catch (e) {
      if (context.mounted) {
        AppSnackbar.showError(context, message: 'Failed to update pins');
      }
    }
  }

  Future<void> _handleTags(
    BuildContext context,
    WidgetRef ref,
    List<String> ids,
  ) async {
    // TagPickerSheet reports the running selection; capture the latest set
    // and merge it into the notes once the sheet is dismissed.
    final selectedTagIds = <String>[];
    await AppBottomSheet.show(
      context,
      builder: (context) => TagPickerSheet(
        selectedTagIds: const [],
        onTagsChanged: (tagIds) {
          selectedTagIds
            ..clear()
            ..addAll(tagIds);
        },
      ),
    );

    if (selectedTagIds.isEmpty || !context.mounted) return;

    try {
      await ref
          .read(notesControllerProvider.notifier)
          .bulkAddTags(ids, selectedTagIds);
      onExitSelectionMode();
      if (context.mounted) {
        AppSnackbar.showSuccess(
          context,
          message: 'Tagged ${_notes(ids.length)}',
        );
      }
    } catch (e) {
      if (context.mounted) {
        AppSnackbar.showError(context, message: 'Failed to add tags');
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notes = ref.watch(notesControllerProvider);
    final query = ref.watch(searchQueryProvider);
    final theme = Theme.of(context);

    final filteredNotes = notes.maybeWhen(
      data: (notesList) {
        return notesList.where((note) {
          if (query.isEmpty) return true;
          final q = query.toLowerCase();
          final contentText = extractPlainTextFromQuillContent(
            note.content,
          ).toLowerCase();
          return note.title.toLowerCase().contains(q) ||
              contentText.contains(q);
        }).toList();
      },
      orElse: () => <Note>[],
    );

    final allSelected =
        filteredNotes.isNotEmpty &&
        selectedNoteIds.length == filteredNotes.length;

    // When every selected note is already pinned, the toggle unpins instead.
    final selectedNotes = filteredNotes
        .where((note) => selectedNoteIds.contains(note.id))
        .toList();
    final allSelectedPinned =
        selectedNotes.isNotEmpty && selectedNotes.every((n) => n.isPinned);
    final selectedSharedCount = notes.maybeWhen(
      data: (notesList) => notesList
          .where((n) => selectedNoteIds.contains(n.id) && !n.isOwner)
          .length,
      orElse: () => 0,
    );

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        // Add tags button
        if (selectedNoteIds.isNotEmpty)
          IconButton(
            icon: const Icon(LucideIcons.tag),
            onPressed: () =>
                _handleTags(context, ref, selectedNoteIds.toList()),
            tooltip: 'Add tags',
          ),
        // Pin / unpin toggle
        if (selectedNoteIds.isNotEmpty)
          IconButton(
            icon: Icon(
              allSelectedPinned ? LucideIcons.pinOff : LucideIcons.pin,
            ),
            onPressed: () => _handlePin(
              context,
              ref,
              selectedNoteIds.toList(),
              !allSelectedPinned,
            ),
            tooltip: allSelectedPinned ? 'Unpin' : 'Pin',
          ),
        // Archive button
        if (selectedNoteIds.isNotEmpty)
          IconButton(
            icon: const Icon(LucideIcons.archive),
            onPressed: () =>
                _handleArchive(context, ref, selectedNoteIds.toList()),
            tooltip: 'Archive',
          ),
        // Delete button
        if (selectedNoteIds.isNotEmpty)
          IconButton(
            icon: const Icon(LucideIcons.trash2),
            onPressed: () => _handleDelete(
              context,
              ref,
              selectedNoteIds.toList(),
              selectedSharedCount,
            ),
            tooltip: 'Delete',
            color: theme.colorScheme.error,
          ),
        // Select all button
        IconButton(
          icon: Icon(
            allSelected ? LucideIcons.checkSquare : LucideIcons.square,
          ),
          onPressed: () {
            if (allSelected) {
              ref.read(selectedNoteIdsProvider.notifier).clear();
            } else {
              ref
                  .read(selectedNoteIdsProvider.notifier)
                  .selectAll(filteredNotes.map((n) => n.id).toList());
            }
          },
          tooltip: allSelected ? 'Deselect all' : 'Select all',
        ),
      ],
    );
  }
}
