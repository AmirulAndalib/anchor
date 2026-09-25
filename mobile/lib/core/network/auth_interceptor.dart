import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../logging/app_logger.dart';
import '../providers/session_expired_provider.dart';

const _accessTokenKey = 'access_token';
const _refreshTokenKey = 'refresh_token';
const _retriedKey = 'authRetried';

// Shared by every Dio instance.
Future<String?>? _refreshing;

/// Adds the access token to requests and refreshes it on a 401.
class AuthInterceptor extends Interceptor {
  AuthInterceptor({
    required Dio dio,
    required Dio refreshDio,
    required FlutterSecureStorage storage,
    required SessionExpired session,
  }) : _dio = dio,
       _refreshDio = refreshDio,
       _storage = storage,
       _session = session;

  final Dio _dio;
  final Dio _refreshDio;
  final FlutterSecureStorage _storage;
  final SessionExpired _session;

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    final token = await _storage.read(key: _accessTokenKey);
    if (token != null) {
      options.headers['Authorization'] = 'Bearer $token';
    }
    handler.next(options);
  }

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    final options = err.requestOptions;
    final sentWith = options.headers['Authorization'];
    // Requests sent signed out (like login) have nothing to refresh.
    if (err.response?.statusCode != 401 ||
        sentWith == null ||
        options.extra[_retriedKey] == true) {
      return handler.next(err);
    }

    final token = await _freshAccessToken(sentWith);
    if (token == null) return handler.next(err);

    try {
      handler.resolve(await _dio.fetch<dynamic>(_retryWith(options, token)));
    } on DioException catch (retryError) {
      handler.reject(retryError);
    }
  }

  Future<String?> _freshAccessToken(Object sentWith) async {
    if (_session.isExpired) return null;

    final stored = await _storage.read(key: _accessTokenKey);
    // Another request already refreshed after this one went out.
    if (stored != null && 'Bearer $stored' != sentWith) return stored;

    return _refreshing ??= _refresh().whenComplete(() => _refreshing = null);
  }

  Future<String?> _refresh() async {
    final refreshToken = await _storage.read(key: _refreshTokenKey);
    if (refreshToken == null) return null;

    try {
      final response = await _refreshDio.post<Map<String, dynamic>>(
        '/api/auth/refresh',
        data: {'refresh_token': refreshToken},
      );
      final data = response.data!;
      final accessToken = data['access_token'] as String;

      await _storage.write(
        key: _refreshTokenKey,
        value: data['refresh_token'] as String,
      );
      await _storage.write(key: _accessTokenKey, value: accessToken);
      return accessToken;
    } on DioException catch (error, stack) {
      if (error.response?.statusCode == 401) {
        AppLogger.instance.warn(
          'Auth',
          'Server refused our sign-in; the user needs to sign in again',
          error: error,
        );
        _session.expire();
      } else {
        AppLogger.instance.error(
          'Auth',
          'Token refresh failed',
          error: error,
          stackTrace: stack,
        );
      }
      return null;
    } catch (error, stack) {
      AppLogger.instance.error(
        'Auth',
        'Token refresh failed',
        error: error,
        stackTrace: stack,
      );
      return null;
    }
  }

  RequestOptions _retryWith(RequestOptions options, String token) {
    final data = options.data;
    return options.copyWith(
      headers: {...options.headers, 'Authorization': 'Bearer $token'},
      // A multipart body can only be sent once.
      data: data is FormData ? data.clone() : data,
      extra: {...options.extra, _retriedKey: true},
    );
  }
}
