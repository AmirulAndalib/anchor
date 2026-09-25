import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/providers/session_expired_provider.dart';
import '../../../core/theme/context_extensions.dart';
import '../../../core/theme/tokens/app_icon_sizes.dart';
import '../../../core/theme/tokens/app_radius.dart';
import '../../../core/widgets/confirm_dialog.dart';
import '../../auth/presentation/auth_controller.dart';
import '../data/sync_compatibility.dart';

/// Banner shown while sync is held back.
class SyncWarning extends ConsumerWidget {
  const SyncWarning({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(sessionExpiredProvider)) {
      return _WarningBanner(
        message: 'Session expired. Sign in again to sync your notes.',
        onTap: () => _signInAgain(context, ref),
      );
    }

    final compatibility = ref.watch(syncCompatibilityProvider).value;
    final message = compatibility?.message;
    if (message == null) return const SizedBox.shrink();

    return _WarningBanner(
      message: message,
      onTap: () => _explain(context, compatibility!),
    );
  }

  Future<void> _signInAgain(BuildContext context, WidgetRef ref) async {
    final confirmed = await ConfirmDialog.show(
      context: context,
      icon: LucideIcons.logIn,
      title: 'Session expired',
      message:
          'Your notes aren\'t syncing until you sign in again. They stay on '
          'this device and sync once you\'re back in.',
      cancelText: 'Later',
      confirmText: 'Sign in',
    );
    if (confirmed != true || !context.mounted) return;
    await ref.read(authControllerProvider.notifier).logout();
  }

  void _explain(BuildContext context, SyncCompatibility compatibility) {
    ConfirmDialog.show(
      context: context,
      icon: LucideIcons.triangleAlert,
      iconColor: Theme.of(context).colorScheme.error,
      title: compatibility.title!,
      message:
          '${compatibility.message}\n\n'
          'Your notes stay available on this device in the meantime.',
      cancelText: null,
      confirmText: 'Got it',
    );
  }
}

class _WarningBanner extends StatelessWidget {
  const _WarningBanner({required this.message, required this.onTap});

  final String message;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dims = context.dims;

    return Padding(
      padding: EdgeInsets.only(bottom: dims.sm),
      child: Material(
        color: theme.colorScheme.errorContainer,
        borderRadius: AppRadius.mdBorder,
        child: InkWell(
          borderRadius: AppRadius.mdBorder,
          onTap: onTap,
          child: Padding(
            padding: EdgeInsets.all(dims.sm),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  LucideIcons.triangleAlert,
                  size: AppIconSizes.md,
                  color: theme.colorScheme.onErrorContainer,
                ),
                SizedBox(width: dims.sm),
                Expanded(
                  child: Text(
                    message,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onErrorContainer,
                    ),
                  ),
                ),
                Icon(
                  LucideIcons.chevronRight,
                  size: AppIconSizes.sm,
                  color: theme.colorScheme.onErrorContainer,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
