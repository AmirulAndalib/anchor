// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'session_expired_provider.dart';

// **************************************************************************
// RiverpodGenerator
// **************************************************************************

// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, type=warning
/// True once the server refuses this device's sign-in, until the user signs
/// in again.

@ProviderFor(SessionExpired)
final sessionExpiredProvider = SessionExpiredProvider._();

/// True once the server refuses this device's sign-in, until the user signs
/// in again.
final class SessionExpiredProvider
    extends $NotifierProvider<SessionExpired, bool> {
  /// True once the server refuses this device's sign-in, until the user signs
  /// in again.
  SessionExpiredProvider._()
    : super(
        from: null,
        argument: null,
        retry: null,
        name: r'sessionExpiredProvider',
        isAutoDispose: false,
        dependencies: null,
        $allTransitiveDependencies: null,
      );

  @override
  String debugGetCreateSourceHash() => _$sessionExpiredHash();

  @$internal
  @override
  SessionExpired create() => SessionExpired();

  /// {@macro riverpod.override_with_value}
  Override overrideWithValue(bool value) {
    return $ProviderOverride(
      origin: this,
      providerOverride: $SyncValueProvider<bool>(value),
    );
  }
}

String _$sessionExpiredHash() => r'4a02224219e9ba4b009f929812cc6fd59ab015d9';

/// True once the server refuses this device's sign-in, until the user signs
/// in again.

abstract class _$SessionExpired extends $Notifier<bool> {
  bool build();
  @$mustCallSuper
  @override
  WhenComplete runBuild() {
    final ref = this.ref as $Ref<bool, bool>;
    final element =
        ref.element
            as $ClassProviderElement<
              AnyNotifier<bool, bool>,
              bool,
              Object?,
              Object?
            >;
    return element.handleCreate(ref, build);
  }
}
