import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'session_expired_provider.g.dart';

/// True once the server refuses this device's sign-in, until the user signs
/// in again.
@Riverpod(keepAlive: true)
class SessionExpired extends _$SessionExpired {
  @override
  bool build() => false;

  bool get isExpired => state;

  void expire() => state = true;

  void clear() => state = false;
}
