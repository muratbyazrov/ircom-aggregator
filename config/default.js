export default {
  // Парсинг
  fetchLimit: 600,
  onlyAds: true,
  adKeywords: [
    'продам', 'продаю', 'куплю', 'сдам', 'аренда',
    'ищу', 'работа', 'вакансия', 'услуги', 'цена',
    'торг', 'руб', 'сом', 'тенге', 'kzt', 'kgs', 'usd',
  ],

  // Хранение
  savePhotos: true,
  photosDir: 'media',
  clearBeforeRun: false,
  retentionDays: 5,

  // Интеграция с ircom-api
  postApiEnabled: true,
  postApiDefaultPrice: 1,
  postApiTimeoutMs: 15000,

  // Загрузка фото в S3
  s3MaxUploadBytes: 10485760,
  s3ImageOptimizationEnabled: true,
  s3ImageMaxDimension: 2000,
  s3ImageQuality: 84,
};
