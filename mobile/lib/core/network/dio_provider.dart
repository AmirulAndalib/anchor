import 'dart:io';
import 'package:dio/dio.dart';
import 'package:dio/io.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../logging/dio_logging_interceptor.dart';
import '../providers/session_expired_provider.dart';
import 'auth_interceptor.dart';
import 'server_config_provider.dart';
import 'anchor_protocol.dart';

part 'dio_provider.g.dart';

/// Creates an [IOHttpClientAdapter] that accepts self-signed/invalid
/// certificates only for the host derived from [serverUrl].
/// Requests to any other host will still reject bad certificates.
IOHttpClientAdapter createSelfSignedCertAdapter(String serverUrl) {
  final uri = Uri.tryParse(serverUrl);
  final allowedHost = uri?.host;

  return IOHttpClientAdapter(
    createHttpClient: () {
      final client = HttpClient();
      client.badCertificateCallback =
          (X509Certificate cert, String host, int port) {
            return host == allowedHost;
          };
      return client;
    },
  );
}

@riverpod
Dio dio(Ref ref) {
  final serverUrl = ref.watch(serverUrlProvider);
  final dio = Dio();

  // Set base URL from server config
  if (serverUrl != null && serverUrl.isNotEmpty) {
    dio.options.baseUrl = serverUrl;
  }

  dio.options.connectTimeout = const Duration(seconds: 10);
  dio.options.receiveTimeout = const Duration(seconds: 10);
  dio.options.headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    anchorProtocolHeader: '$anchorProtocol',
  };

  // Allow self-signed certificates when the user has enabled the setting
  final allowSelfSigned = ref.watch(allowSelfSignedCertProvider).value ?? false;
  if (allowSelfSigned && serverUrl != null && serverUrl.isNotEmpty) {
    dio.httpClientAdapter = createSelfSignedCertAdapter(serverUrl);
  }

  // Separate client so refreshing skips the interceptors.
  final refreshDio = Dio();
  if (serverUrl != null && serverUrl.isNotEmpty) {
    refreshDio.options.baseUrl = serverUrl;
  }
  refreshDio.options.connectTimeout = const Duration(seconds: 10);
  refreshDio.options.receiveTimeout = const Duration(seconds: 10);
  refreshDio.options.headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (allowSelfSigned && serverUrl != null && serverUrl.isNotEmpty) {
    refreshDio.httpClientAdapter = createSelfSignedCertAdapter(serverUrl);
  }

  dio.interceptors.add(
    AuthInterceptor(
      dio: dio,
      refreshDio: refreshDio,
      storage: const FlutterSecureStorage(),
      session: ref.read(sessionExpiredProvider.notifier),
    ),
  );

  // Transform DioException into user-friendly error
  dio.interceptors.add(
    InterceptorsWrapper(
      onError: (e, handler) => handler.next(_transformError(e)),
    ),
  );

  // Always log requests/responses (with redaction) so users can collect
  // diagnostics without a hidden toggle.
  dio.interceptors.add(AppLoggingInterceptor());

  return dio;
}

/// Transform DioException into a more user-friendly error with better messages
DioException _transformError(DioException e) {
  // If there's already a response with a message, preserve it
  if (e.response?.data != null && e.response!.data is Map) {
    final data = e.response!.data as Map<String, dynamic>;
    if (data.containsKey('message')) {
      // Server already provided a message, use it
      return e;
    }
  }

  // Transform based on error type
  String message;
  switch (e.type) {
    case DioExceptionType.connectionTimeout:
      message =
          'Connection timeout. Please check your internet connection and try again.';
      break;
    case DioExceptionType.sendTimeout:
      message = 'Request timeout. Please try again.';
      break;
    case DioExceptionType.receiveTimeout:
    case DioExceptionType.transformTimeout:
      message = 'Response timeout. Please try again.';
      break;
    case DioExceptionType.connectionError:
      message = 'No internet connection. Please check your network settings.';
      break;
    case DioExceptionType.badCertificate:
      message =
          'Certificate error. If using a self-signed certificate, enable "Allow self-signed certificates" in server settings.';
      break;
    case DioExceptionType.badResponse:
      // Handle specific status codes
      final statusCode = e.response?.statusCode;
      switch (statusCode) {
        case 400:
          message = 'Invalid request. Please check your input.';
          break;
        case 401:
          message = 'Authentication required. Please log in again.';
          break;
        case 403:
          message = 'Permission denied.';
          break;
        case 404:
          message = 'Resource not found.';
          break;
        case upgradeRequiredStatus:
          message = 'App and server versions are incompatible.';
          break;
        case 500:
          message = 'Server error. Please try again later.';
          break;
        case 502:
        case 503:
        case 504:
          message = 'Server unavailable. Please try again later.';
          break;
        default:
          message = 'Request failed. Please try again.';
      }
      break;
    case DioExceptionType.cancel:
      message = 'Request cancelled.';
      break;
    case DioExceptionType.unknown:
      // Check if it's a network-related error
      if (e.error?.toString().contains('SocketException') == true ||
          e.error?.toString().contains('Network is unreachable') == true) {
        message = 'No internet connection. Please check your network settings.';
      } else {
        message = 'An unexpected error occurred. Please try again.';
      }
      break;
  }

  // Create a new DioException with the transformed message
  // Preserve the original error but add the message to response data
  if (e.response != null) {
    final response = e.response!;
    final data = response.data is Map
        ? Map<String, dynamic>.from(response.data as Map)
        : <String, dynamic>{};
    data['message'] = message;
    return DioException(
      requestOptions: e.requestOptions,
      response: Response(
        data: data,
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        headers: response.headers,
        requestOptions: response.requestOptions,
      ),
      type: e.type,
      error: e.error,
      stackTrace: e.stackTrace,
    );
  }

  // For errors without response, create a synthetic response with the message
  return DioException(
    requestOptions: e.requestOptions,
    response: Response(
      data: {'message': message},
      statusCode: e.response?.statusCode ?? 0,
      requestOptions: e.requestOptions,
    ),
    type: e.type,
    error: e.error,
    stackTrace: e.stackTrace,
  );
}
