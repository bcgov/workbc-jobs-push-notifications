import {AxiosInstance} from 'axios';

const axios = require('axios');

const notificationsBaseUrl = process.env.NOTIFICATIONS_API_URL || '';
const jobsBaseUrl = process.env.JOBS_API_URL || '';

export const notificationsApi: AxiosInstance = axios.create({
  baseURL: 'https://m-notif-test.es.workbc.ca/messaging/send',
});

export const jobsApi: AxiosInstance = axios.create({
  baseURL: jobsBaseUrl,
});
