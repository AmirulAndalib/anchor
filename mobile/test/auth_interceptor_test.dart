import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:anchor/core/network/auth_interceptor.dart';
import 'package:anchor/core/providers/session_expired_provider.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

/// Answers every request with [respond], and remembers what it was sent.
class _FakeServer implements HttpClientAdapter {
  _FakeServer(this.respond);

  Future<ResponseBody> Function(RequestOptions options) respond;
  final requests = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    await requestStream?.drain<void>();
    return respond(options);
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody _json(int status, Object body) => ResponseBody.fromString(
  jsonEncode(body),
  status,
  headers: {
    Headers.contentTypeHeader: [Headers.jsonContentType],
  },
);

ResponseBody _newTokens() =>
    _json(200, {'access_token': 'new-access', 'refresh_token': 'new-refresh'});

void main() {
  const storage = FlutterSecureStorage();
  late ProviderContainer container;
  late SessionExpired session;
  late _FakeServer api;
  late _FakeServer auth;
  late Dio dio;

  // The API accepts only the new access token.
  Future<ResponseBody> api401UntilRefreshed(RequestOptions options) async =>
      options.headers['Authorization'] == 'Bearer new-access'
      ? _json(200, {'ok': true})
      : _json(401, {'message': 'Unauthorized'});

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({
      'access_token': 'old-access',
      'refresh_token': 'old-refresh',
    });
    container = ProviderContainer();
    addTearDown(container.dispose);
    session = container.read(sessionExpiredProvider.notifier);

    api = _FakeServer(api401UntilRefreshed);
    auth = _FakeServer((_) async => _newTokens());

    final options = BaseOptions(baseUrl: 'https://anchor.test');
    final refreshDio = Dio(options)..httpClientAdapter = auth;
    dio = Dio(options)..httpClientAdapter = api;
    dio.interceptors.add(
      AuthInterceptor(
        dio: dio,
        refreshDio: refreshDio,
        storage: storage,
        session: session,
      ),
    );
  });

  test('refreshes once when several requests hit a 401 together', () async {
    final responses = await Future.wait([
      dio.get<dynamic>('/api/notes'),
      dio.get<dynamic>('/api/tags'),
      dio.post<dynamic>('/api/sync'),
    ]);

    expect(responses.map((r) => r.statusCode), everyElement(200));
    expect(auth.requests, hasLength(1));
    expect(await storage.read(key: 'access_token'), 'new-access');
    expect(await storage.read(key: 'refresh_token'), 'new-refresh');
  });

  test(
    'asks the user to sign in again when the server refuses the refresh token',
    () async {
      auth.respond = (_) async => _json(401, {'message': 'Invalid'});

      await expectLater(
        dio.get<dynamic>('/api/notes'),
        throwsA(
          isA<DioException>().having(
            (e) => e.response?.statusCode,
            'status',
            401,
          ),
        ),
      );
      expect(session.isExpired, isTrue);

      await expectLater(dio.get<dynamic>('/api/tags'), throwsA(anything));
      expect(auth.requests, hasLength(1));
    },
  );

  test('keeps the tokens when the refresh gets no answer', () async {
    auth.respond = (_) async => throw const SocketException('offline');

    await expectLater(dio.get<dynamic>('/api/notes'), throwsA(anything));
    expect(session.isExpired, isFalse);
    expect(await storage.read(key: 'refresh_token'), 'old-refresh');

    auth.respond = (_) async => _newTokens();
    final response = await dio.get<dynamic>('/api/notes');
    expect(response.statusCode, 200);
  });

  test('keeps the tokens when the server fails the refresh', () async {
    auth.respond = (_) async => _json(502, {'message': 'Bad gateway'});

    await expectLater(dio.get<dynamic>('/api/notes'), throwsA(anything));
    expect(session.isExpired, isFalse);
    expect(await storage.read(key: 'refresh_token'), 'old-refresh');
  });

  test('sends the request again with its original settings', () async {
    final cancelToken = CancelToken();

    await dio.get<ResponseBody>(
      '/api/sync/events',
      cancelToken: cancelToken,
      options: Options(
        responseType: ResponseType.stream,
        receiveTimeout: Duration.zero,
      ),
    );

    final retry = api.requests.last;
    expect(retry.headers['Authorization'], 'Bearer new-access');
    expect(retry.responseType, ResponseType.stream);
    expect(retry.receiveTimeout, Duration.zero);
    expect(retry.cancelToken, same(cancelToken));
  });

  test('sends a multipart body again after a refresh', () async {
    final response = await dio.post<dynamic>(
      '/api/notes/n1/attachments',
      data: FormData.fromMap({
        'file': MultipartFile.fromString('hello', filename: 'a.txt'),
      }),
    );

    expect(response.statusCode, 200);
  });

  test('uses a token another request already refreshed', () async {
    api.respond = (options) async {
      if (options.headers['Authorization'] == 'Bearer old-access') {
        // Another request refreshed while this one was on its way.
        await storage.write(key: 'access_token', value: 'new-access');
      }
      return api401UntilRefreshed(options);
    };

    final response = await dio.get<dynamic>('/api/notes');

    expect(response.statusCode, 200);
    expect(auth.requests, isEmpty);
  });

  test('does not refresh for requests sent signed out', () async {
    FlutterSecureStorage.setMockInitialValues({});

    await expectLater(dio.post<dynamic>('/api/auth/login'), throwsA(anything));
    expect(auth.requests, isEmpty);
    expect(session.isExpired, isFalse);
  });
}
