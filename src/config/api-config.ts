import { AxiosInstance } from "axios"

const axios = require("axios")

const notificationsBaseUrl = process.env.NOTIFICATIONS_API_URL || ""
const jobsBaseUrl = process.env.JOBS_API_URL || ""

export const notificationsApi: AxiosInstance = axios.create(
    {
        baseURL: notificationsBaseUrl
    }
)

export const jobsApi: AxiosInstance = axios.create(
    {
        baseURL: jobsBaseUrl
    }
)
